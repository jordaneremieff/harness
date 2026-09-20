/**
 * agent/worker: one durable AgentHarness session + ordinary public
 * ExtensionRunner host per agent session.
 *
 * The harness owns the model loop, storage, inbox, results, reducer, and tool
 * progress. This module owns only host adaptation: extension and resource
 * discovery through the ordinary public loader, project-trust resolution,
 * tool-surface assembly, interception and provider/context hook mapping,
 * lifecycle events, the session-view projection feed, nonblocking admission,
 * abort, and lane steer/follow-up plumbing.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clampThinkingLevel, type ImageContent } from "@earendil-works/pi-ai";
import {
	AgentHarness,
	serializeConversation,
	type AgentHarnessTool,
	type AgentLane,
	type AgentMessage,
	type Context,
	type CustomEntry,
	type Entry,
	type ExecutionToolContext,
	type HarnessEvent,
	type LaneSnapshot,
	type Session as HarnessSession,
	type Skill,
	type ThinkingLevel,
	type WatchHandle,
	type Write,
} from "@earendil-works/pi-agent-core";
const { value: valueAddress, branchTip, entryLabel, insertEntry, sessionName, setValue, laneConfig, laneState, operationState } = await import(corePublicImportUrl("./harness/session")) as typeof import("@earendil-works/pi-agent-core/harness/session");
import {
	convertToLlm,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	type AgentSession,
	type BuildSystemPromptOptions,
	type NormalizedBuildSystemPromptOptions,
	type AgentToolResult,
	createEventBus,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	type RegisteredTool,
	type ToolDefinition,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	estimateTokens,
	getLastAssistantUsage,
	type ExtensionActions,
	type ExtensionContextActions,
	ExtensionRunner,
	getAgentDir,
	hasTrustRequiringProjectResources,
	type LoadExtensionsResult,
	ModelRegistry,
	type SessionMessageEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
	type ModelRuntime,
	type ProjectTrustStore,
	SessionManager,
	SettingsManager,
	type ToolCallEvent,
	type ToolInfo,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CUSTOM_MESSAGE_WRAPPER_TYPE,
	customMessagePayloadOf,
	LABEL_CHANGE_ENTRY_TYPE,
	MODEL_CHANGE_ENTRY_TYPE,
	NAME_CHANGE_ENTRY_TYPE,
	SessionView,
	THINKING_CHANGE_ENTRY_TYPE,
	type SessionViewIdentity,
} from "./session-view.ts";
import { corePublicImportUrl, type AgentSessionMetadata, type AgentStore } from "./store.ts";
import { installWorkerLifecycle, type WorkerNavigationDecision } from "./worker-lifecycle.ts";
import { createWorkerModels, createWorkerPromptObserver, renderWorkerPrompt, executeWorkerBash, normalizeWorkerUserContent, prepareWorkerInput, prepareWorkerQueuedInput, type WorkerInputResources } from "./worker-host.ts";

export const MAIN_LANE = "main";
export const META_CUSTOM_TYPE = "agent.meta";

// Reserved mutation-history custom types: defined next to the projection that
// renders them as ordinary typed entries, re-exported for callers.
export {
	LABEL_CHANGE_ENTRY_TYPE,
	MODEL_CHANGE_ENTRY_TYPE,
	NAME_CHANGE_ENTRY_TYPE,
	THINKING_CHANGE_ENTRY_TYPE,
};

export interface WorkerModelChoice {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

/** Command context bound to the replacement session after new/fork/switch. */
export type ReplacedSessionContext = ReturnType<AgentSession["createReplacedSessionContext"]>;

/** Session-lifecycle operations used by extension command contexts. */
export interface WorkerLifecycle {
	newSession(cwd: string, model: WorkerModelChoice, plan: {
		setup?: (sessionManager: SessionManager) => Promise<void>;
		parentSession?: string;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<string>;
	forkSession(entryId: string | undefined, position: "before" | "at" | undefined, plan: {
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<string>;
	switchSession(target: string, plan: {
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<string>;
}

export class UnavailableAgentModelError extends Error {
	readonly sessionId: string;
	readonly cwd: string;
	readonly model: WorkerModelChoice;
	constructor(sessionId: string, cwd: string, model: WorkerModelChoice) {
		super(`Model ${model.provider}/${model.modelId} is unavailable for session ${sessionId}. Use agent_attach with an explicit available provider/model to repair an idle session.`);
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.model = model;
	}
}

export interface WorkerCreateOptions {
	cwd: string;
	agentDir?: string;
	/** Explicit project-trust decision for cwd resources. When absent, the ordinary order decides: extension project_trust event, stored decision, settings default, then deny (no UI in a worker). */
	trusted?: boolean;
	/** Trust store used to persist and read project-trust decisions. */
	trustStore?: ProjectTrustStore;
	/** Source session file path for forked sessions (ordinary header parentSession). */
	parentSessionPath?: string;
	/** Session-lifecycle operations (new/fork/switch) used by extension command contexts. */
	lifecycle?: WorkerLifecycle;
	/** Explicit model for new sessions. Optional for open/fork, which prefer the session's durable model entry. */
	model?: WorkerModelChoice;
	/** Explicit operator-selected replacement for an idle stored session, never an implicit fallback. */
	repairModel?: WorkerModelChoice;
	extensionPaths?: string[];
	skillPaths?: string[];
	name?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	onSessionCreated?: (sessionId: string) => void;
	onSessionClosed?: (sessionId: string) => void;
	trustPrompt?: (cwd: string) => Promise<boolean | undefined>;
	store: AgentStore;
	modelRuntime: ModelRuntime;
	rootContext: Context;
	onUpdate?: (update: WorkerUpdate) => void;
}

export type WorkerUpdate =
	| { kind: "entry"; lane: string; entry: Entry }
	| { kind: "operation"; lane: string; operationId: string; status: string }
	| { kind: "error"; lane: string; message: string }
	| { kind: "queues"; lane: string; pending: number };

export interface WorkerStatus {
	sessionId: string;
	cwd: string;
	name?: string;
	lane: string;
	tipId: string | null;
	model: { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
	operation: string | null;
	tools: string[];
	activeTools: string[];
	extensions: string[];
	entryCount: number;
	lastError?: string;
}

/** Result of running one registered extension command in this session. */
export interface WorkerCommandResult {
	/** Operator-facing result text; empty when the command produced none. */
	text: string;
	/** Present when the command replaced or forked its session. */
	sessionId?: string;
}

interface ContextUsageShape {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

const sessionStartEvent = { type: "session_start" as const, reason: "startup" as const };

const CORE_TOOL_NAMES = new Set(["bash", "read", "write", "edit"]);
const RUN_PROMPT = valueAddress<{ runId: string; options: NormalizedBuildSystemPromptOptions }>("agent.run", "prompt");

function toolNameToCallEvent(toolName: string, toolCallId: string, args: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolName, toolCallId, input: args } as ToolCallEvent;
}

function toolNameToResultEvent(
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
	event: {
		content: AgentToolResult<unknown>["content"];
		details?: unknown;
		isError: boolean;
		usage?: unknown;
	},
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName,
		toolCallId,
		input,
		content: event.content,
		details: event.details,
		isError: event.isError,
		usage: event.usage,
	} as ToolResultEvent;
}

type ContentPart = { type: "text"; text?: string } | { type: "image"; data?: string; mimeType?: string };

/** Convert extension message content into one user-role model message. */
function contentToAgentMessage(content: string | ContentPart[]): AgentMessage {
	if (typeof content === "string") return { role: "user", content } as AgentMessage;
	const parts = content.map((part) =>
		part.type === "image"
			? { type: "image", data: part.data ?? "", mimeType: part.mimeType ?? "image/png" }
			: { type: "text", text: part.text ?? "" },
	);
	return { role: "user", content: parts } as AgentMessage;
}

function textContentOf(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function imagesOf(messages: AgentMessage[]): Array<{ type: "image"; data: string; mimeType: string }> {
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "image" && typeof part.data === "string") {
				images.push({ type: "image", data: part.data, mimeType: part.mimeType });
			}
		}
	}
	return images;
}

function textFragment(text: string, offset: number, maxBytes: number) {
	let bytes = 0;
	let end = offset;
	for (const character of text.slice(offset)) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += character.length;
	}
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null, truncated: end < text.length };
}

type HostToolContext = ExecutionToolContext;

export class AgentWorkerSession {
	private readonly options: WorkerCreateOptions;
	private session: HarnessSession<AgentSessionMetadata> | undefined;
	private harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"] | undefined;
	private lane: AgentLane | undefined;
	private runner: ExtensionRunner | undefined;
	private view: SessionView | undefined;
	private extensionsResult: LoadExtensionsResult | undefined;
	private context: Context;
	private currentSignal: AbortSignal | undefined;
	private operationController: AbortController | undefined;
	private busy = false;
	private bashController: AbortController | undefined;
	private bashTask: Promise<AgentMessage> | undefined;
	private driveTask: Promise<void> | undefined;
	private closeTask: Promise<void> | undefined;
	private readonly pendingActions = new Set<Promise<unknown>>();
	private lifecycleDispose: (() => void) | undefined;
	private navigationDecision: WorkerNavigationDecision | undefined;
	private navigationController: AbortController | undefined;
	private branchInstructions: string | undefined;
	private branchPrompt: string | undefined;
	private branchRequest = false;
	private navigationLabel: string | undefined;
	private readonly pendingBashMessages: AgentMessage[] = [];
	private toolset: Array<AgentHarnessTool<HostToolContext>> = [];
	private toolInfos: ToolInfo[] = [];
	private activeToolNames: string[] = [];
	private restoredToolNames: string[] | undefined;
	private modelChoice: WorkerModelChoice | undefined;
	private trusted: boolean | undefined;
	private laneWatcher: { handle: WatchHandle<LaneSnapshot>; snapshot: LaneSnapshot; refreshing: boolean } | undefined;
	private lastError: string | undefined;
	private inputResources: WorkerInputResources = { skills: [], promptTemplates: [] };
	private resourceLoader: DefaultResourceLoader | undefined;
	private promptObserver = createWorkerPromptObserver();
	private currentPrompt: (() => string) | undefined;
	private basePrompt = "";

	private constructor(options: WorkerCreateOptions) {
		this.options = options;
		this.context = options.rootContext;
	}

	private get cwd(): string {
		return this.options.cwd;
	}

	private get agentDir(): string {
		return this.options.agentDir ?? process.env.PI_AGENT_DIR ?? getAgentDir();
	}

	sessionId(): string {
		if (!this.session) throw new Error("agent session not attached");
		return this.session.metadata.id;
	}

	sessionMetadata(): AgentSessionMetadata {
		if (!this.session) throw new Error("agent session not attached");
		return { ...this.session.metadata };
	}

	/** Install session-lifecycle operations after construction (the manager wires the owner id lazily). */
	setLifecycle(lifecycle: WorkerLifecycle): void {
		this.options.lifecycle = lifecycle;
	}

	/** The synchronous read projection extensions see as ctx.sessionManager. */
	sessionManager(): SessionView {
		return this.requireView();
	}

	isProjectTrusted(): boolean {
		return this.trusted ?? true;
	}

	static async create(options: WorkerCreateOptions): Promise<AgentWorkerSession> {
		const worker = new AgentWorkerSession(options);
		if (!options.model) throw new Error("agent session create requires an explicit model");
		const setupManager = options.setup ? SessionManager.inMemory(options.cwd) : undefined;
		if (setupManager && options.setup) {
			await options.setup(setupManager);
			const parent = setupManager.getHeader()?.parentSession;
			if (parent) options.parentSessionPath = parent;
		}
		const session = await options.store.create(options.cwd, worker.context, setupManager?.getSessionId());
		try {
			if (setupManager) await worker.seedSetup(session, setupManager);
			await worker.attachToSession(session, session.metadata);
			return worker;
		} catch (error) {
			await worker.closeFailedStartup(session, error);
			throw error;
		}
	}

	private async closeFailedStartup(session: HarnessSession<AgentSessionMetadata>, error: unknown): Promise<void> {
		this.session ??= session;
		try { await this.close("startup-failed"); }
		catch (cleanup) { throw new AggregateError([error, cleanup], "agent session startup failed; cleanup also failed", { cause: error }); }
	}

	static async open(metadata: AgentSessionMetadata, options: WorkerCreateOptions): Promise<AgentWorkerSession> {
		const worker = new AgentWorkerSession(options);
		const session = await options.store.open(metadata, worker.context);
		try {
			await worker.attachToSession(session, session.metadata);
			return worker;
		} catch (error) {
			await worker.closeFailedStartup(session, error);
			throw error;
		}
	}

	static async fork(
		sourceMetadata: AgentSessionMetadata,
		options: WorkerCreateOptions & { branch?: string; entryId?: string; position?: "before" | "at" },
	): Promise<AgentWorkerSession> {
		const worker = new AgentWorkerSession({
			...options,
			parentSessionPath: sourceMetadata.path,
		});
		const session = await options.store.fork(sourceMetadata, options.branch ?? MAIN_LANE, worker.context, {
			entryId: options.entryId,
			position: options.position,
		});
		try {
			await worker.attachToSession(session, session.metadata);
			return worker;
		} catch (error) {
			await worker.closeFailedStartup(session, error);
			throw error;
		}
	}

	/** Ordinary project-trust order: override, ungated, extension event, stored decision, settings default, deny without UI. */
	private async resolveProjectTrusted(extensionsResult: LoadExtensionsResult): Promise<boolean> {
		if (this.options.trusted !== undefined) return this.options.trusted;
		if (!hasTrustRequiringProjectResources(this.cwd)) return true;
		const extensionDecision = await this.emitProjectTrustEvent(extensionsResult);
		if (extensionDecision) {
			if (extensionDecision.remember === true) {
				this.options.trustStore?.set(this.cwd, extensionDecision.trusted === "yes");
			}
			return extensionDecision.trusted === "yes";
		}
		const stored = this.options.trustStore?.get(this.cwd) ?? null;
		if (stored !== null) return stored;
		let defaultTrust: "always" | "never" | "ask" = "ask";
		try {
			defaultTrust = SettingsManager.create(this.cwd, this.agentDir).getDefaultProjectTrust();
		} catch {
			// Unreadable settings fall back to the ordinary default ("ask").
		}
		if (defaultTrust === "always") return true;
		if (defaultTrust === "never") return false;
		const prompted = await this.options.trustPrompt?.(this.cwd);
		if (prompted !== undefined) this.options.trustStore?.set(this.cwd, prompted);
		return prompted ?? false;
	}

	/** Same aggregation as the ordinary emitProjectTrustEvent: first yes/no wins, undecided falls through. */
	private async emitProjectTrustEvent(
		extensionsResult: LoadExtensionsResult,
	): Promise<{ trusted: "yes" | "no"; remember?: boolean } | undefined> {
		const event = { type: "project_trust", cwd: this.cwd };
		for (const extension of extensionsResult.extensions) {
			const handlers = extension.handlers.get("project_trust");
			if (!handlers || handlers.length === 0) continue;
			for (const handler of handlers) {
				try {
					const result = (await handler(event, {
						cwd: this.cwd,
						mode: "print",
						hasUI: false,
						ui: {
							notify: () => {},
							select: async () => undefined,
							confirm: async () => false,
							input: async () => undefined,
						},
					} as never)) as { trusted?: string; remember?: boolean } | undefined;
					if (!result || result.trusted === "undecided") continue;
					return { trusted: result.trusted as "yes" | "no", ...(result.remember === undefined ? {} : { remember: result.remember }) };
				} catch {
					// Handler errors are containment-only here; the ordinary path also continues.
				}
			}
		}
		return undefined;
	}

	private async attachToSession(session: HarnessSession<AgentSessionMetadata>, metadata: AgentSessionMetadata, reason: "startup" | "reload" = "startup"): Promise<void> {
		this.session = session;
		this.closeTask = undefined;
		this.options.onSessionCreated?.(session.metadata.id);
		const parentAddress = valueAddress<string>("agent.header", "parentSession");
		if (this.options.parentSessionPath) {
			await session.mutate(async (mutator, context) => { await mutator.commit([setValue(parentAddress, this.options.parentSessionPath!)], context); }, this.context);
		} else {
			this.options.parentSessionPath = (await session.getValue(parentAddress, this.context))?.value;
		}
		const storedBranch = await session.branch(MAIN_LANE, this.context);
		const storedMeta = storedBranch ? (await storedBranch.findEntries({ type: "custom", customType: META_CUSTOM_TYPE, order: "newestFirst", limit: 1 }, this.context))[0] : undefined;
		if (storedMeta?.type === "custom" && storedMeta.data && typeof storedMeta.data === "object") {
			const data = storedMeta.data as Record<string, unknown>;
			if (Array.isArray(data.extensionPaths) && data.extensionPaths.every((path) => typeof path === "string")) this.options.extensionPaths ??= data.extensionPaths;
			if (Array.isArray(data.skillPaths) && data.skillPaths.every((path) => typeof path === "string")) this.options.skillPaths ??= data.skillPaths;
			if (typeof data.parentSessionPath === "string") this.options.parentSessionPath ??= data.parentSessionPath;
		}

		// Extension/resources discovery through the ordinary public resource loader
		// (agentDir + cwd project + additional paths), with the loader-invoked
		// project-trust callback running the ordinary resolution order.
		const eventBus = createEventBus();
		const loader = this.resourceLoader ?? new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			eventBus,
			additionalExtensionPaths: this.options.extensionPaths ?? [],
			additionalSkillPaths: this.options.skillPaths ?? [],
		});
		this.resourceLoader = loader;
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				const decision = await this.resolveProjectTrusted(extensionsResult);
				this.trusted = decision;
				return decision;
			},
		});
		this.extensionsResult = loader.getExtensions();
		if (this.extensionsResult.errors.length > 0) {
			throw new Error(this.extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
		}
		// Provider declarations must exist before model selection. The public
		// runtime queues factory registrations until the host binds actions.
		for (const registration of this.extensionsResult.runtime.pendingProviderRegistrations.splice(0)) {
			this.options.modelRuntime.registerProvider(registration.name, registration.config);
		}
		for (const registration of this.extensionsResult.runtime.pendingNativeProviderRegistrations.splice(0)) {
			this.options.modelRuntime.registerNativeProvider(registration.provider);
		}
		this.agentContextFiles = loader.getAgentsFiles().agentsFiles;
		this.inputResources = { skills: loader.getSkills().skills, promptTemplates: loader.getPrompts().prompts };
		const skillResources: Skill[] = loader.getSkills().skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			content: readFileSync(skill.filePath, "utf8"),
			filePath: skill.filePath,
			...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
		}));
		const promptResources = loader.getPrompts().prompts.map((template) => ({
			name: template.name,
			...(template.description === undefined ? {} : { description: template.description }),
			content: template.content,
		}));
		this.harnessResources = {
			...(skillResources.length > 0 ? { skills: skillResources } : {}),
			...(promptResources.length > 0 ? { promptTemplates: promptResources } : {}),
		};

		// Durable model choice: the stored agent.meta entry wins; create seeds it
		// through the lane once the harness configures the branch.
		this.restoredToolNames = (await session.getValue(laneConfig(MAIN_LANE), this.context))?.value.activeToolNames;
		const durableModel = await this.readModelEntry(session);
		let seedMeta = false;
		let modelChoice: WorkerModelChoice;
		if (durableModel) {
			modelChoice = durableModel;
		} else if (this.options.model) {
			modelChoice = this.options.model;
			seedMeta = true;
		} else {
			throw new Error(`agent session ${session.metadata.id} has no durable model entry; reopen with an explicit model`);
		}
		const repair = this.options.repairModel;
		if (repair) {
			const state = (await session.getValue(laneState(MAIN_LANE), this.context))?.value;
			if (state?.currentOperationId || state?.inbox.length) throw new Error("Model repair requires an idle session with no queued input. It does not abort or rewrite an active operation.");
			modelChoice = { ...repair, thinkingLevel: repair.thinkingLevel ?? modelChoice.thinkingLevel };
		}
		const model = this.options.modelRuntime.getModel(modelChoice.provider, modelChoice.modelId);
		if (!model) throw new UnavailableAgentModelError(session.metadata.id, this.cwd, modelChoice);
		if (repair && !this.options.modelRuntime.hasConfiguredAuth(modelChoice.provider) && !(await this.options.modelRuntime.checkAuth(modelChoice.provider))) {
			throw new Error(`Authentication is not configured for ${modelChoice.provider}; the stored model is unchanged`);
		}
		// The durable level can outlive the model that supported it, and a level
		// inherited from another session can exceed the selected model. Clamp
		// before the harness seeds its configuration and again after the lane
		// restores its own stored configuration.
		const seededThinking = modelChoice.thinkingLevel ? clampThinkingLevel(model, modelChoice.thinkingLevel) : undefined;
		const { harness } = await AgentHarness.create(
			{
				session,
				models: createWorkerModels(this.options.modelRuntime, () => this.runner, (context) => {
					if (!this.branchRequest || this.branchPrompt === undefined) return context;
					const message = context.messages[0];
					if (context.messages.length !== 1 || message?.role !== "user") throw new Error("Unexpected native branch summary request shape");
					return { ...context, messages: [{ ...message, content: [{ type: "text", text: this.branchPrompt }] }] };
				}),
				toProviderMessages: convertToLlm,
				model,
				systemPrompt: () => {
					if (!this.currentPrompt) throw new Error("The active run has no recorded prompt state; start a new run instead of reconstructing missing hook state");
					return this.currentPrompt();
				},
				resources: this.harnessResources,
				toolContext: { env: this.options.store.envFor(this.cwd) },
				tools: [],
				entryProjectors: {
					[CUSTOM_MESSAGE_WRAPPER_TYPE]: async (entry: CustomEntry) => {
						const payload = customMessagePayloadOf(entry.data);
						return payload ? [contentToAgentMessage(payload.content)] : [];
					},
				},
				...(seededThinking ? { thinkingLevel: seededThinking } : {}),
			},
			this.context,
		);
		this.harness = harness;
		this.lane = await harness.lane(MAIN_LANE, this.context);
		if (repair) {
			await this.lane.setModel({ provider: modelChoice.provider, modelId: modelChoice.modelId }, this.context);
			await this.lane.setThinkingLevel(seededThinking ?? "off", this.context);
			await this.lane.appendCustomEntry(MODEL_CHANGE_ENTRY_TYPE, { provider: modelChoice.provider, modelId: modelChoice.modelId }, this.context);
			this.options.repairModel = undefined;
		}
		if (seedMeta) {
			await this.lane.appendCustomEntry(
				META_CUSTOM_TYPE,
				{
					provider: modelChoice.provider,
					modelId: modelChoice.modelId,
					...(seededThinking ? { thinkingLevel: seededThinking } : {}),
					...(this.options.extensionPaths ? { extensionPaths: this.options.extensionPaths } : {}),
					...(this.options.skillPaths ? { skillPaths: this.options.skillPaths } : {}),
					...(this.options.parentSessionPath ? { parentSessionPath: this.options.parentSessionPath } : {}),
				},
				this.context,
			);
		}
		// Cache the lane's own configuration so extension getters report live state.
		const [laneModel, laneThinking] = await Promise.all([
			this.lane.getModel(this.context),
			this.lane.getThinkingLevel(this.context),
		]);
		// A durable level stored under another model can exceed the selected
		// model's supported set; clamp the restored lane configuration.
		const effectiveThinking = laneThinking ? clampThinkingLevel(model, laneThinking) : undefined;
		if (effectiveThinking && effectiveThinking !== laneThinking) {
			await this.lane.setThinkingLevel(effectiveThinking, this.context);
		}
		this.modelChoice = {
			provider: laneModel?.provider ?? modelChoice.provider,
			modelId: laneModel?.id ?? modelChoice.modelId,
			...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
		};

		// Synchronous read projection over the durable session branch. Constructed
		// after the harness/lane exist; initialize() snapshots atomically.
		const identity: SessionViewIdentity = {
			sessionId: session.metadata.id,
			cwd: this.cwd,
			createdAtMs: session.metadata.createdAt,
			...(this.options.parentSessionPath ? { parentSession: this.options.parentSessionPath } : {}),
			sessionDir: metadata.path.length > 0 ? metadata.path.slice(0, metadata.path.lastIndexOf("/")) : "",
			sessionFile: metadata.path,
		};
		const view = new SessionView(identity, {
			load: async () => {
				const branch = await session.branch(MAIN_LANE, this.context);
				const entries = await session.findEntries({ order: "asc" }, this.context);
				const setupPointers = await session.scanValues(valueAddress<string>("agent.setup.first-kept"), this.context);
				const entryDetails = await session.scanValues(valueAddress("agent.entry.details"), this.context);
				const rawLabels = await session.scanValues(valueAddress("pi.entry.label"), this.context);
				const labels = rawLabels.map((stored) => ({
					targetId: String((stored.address as { key?: unknown }).key),
					label: String(stored.value),
				}));
				const name = await harness.getName(this.context);
				const tipId = branch ? await branch.getTipId(this.context) : null;
				return { entries, labels, name, tipId, firstKeptEntries: setupPointers.map((stored) => ({ id: stored.address.key, firstKeptEntryId: stored.value })), entryDetails: entryDetails.map((stored) => ({ id: stored.address.key, details: stored.value })) };
			},
			onEntryAdded: (listener) =>
				this.onSessionEvent("entry_added", (event) => {
					listener((event as { entry: Entry }).entry);
					return undefined;
				}),
			onValueUpdate: (listener) =>
				this.onSessionEvent("value_update", (event) => {
					listener(event as never);
					return undefined;
				}),
		});
		this.view = view;
		await view.initialize();

		this.promptObserver = createWorkerPromptObserver();
		this.currentPrompt = undefined;
		const runner = new ExtensionRunner(
			[...this.extensionsResult.extensions, this.promptObserver.extension],
			this.extensionsResult.runtime,
			this.cwd,
			// The runner parameter is the nominally typed coding-agent SessionManager
			// class (private constructor): no non-SessionManager value satisfies it
			// structurally. Extensions receive the synchronous read projection; writes
			// route through the actions. Full-SessionManager consumers (newSession
			// setup callbacks) receive a real SessionManager via runSetupHook.
			view as never,
			new ModelRegistry(this.options.modelRuntime),
		);
		this.runner = runner;
		runner.onError((error) => {
			this.lastError = `${error.event}: ${error.error}`;
			this.options.onUpdate?.({ kind: "error", lane: MAIN_LANE, message: this.lastError });
		});
		this.bindExtensionActions(runner);
		this.bindCommands(runner);
		this.installInterception(runner);
		this.installProviderHooks(runner);
		this.installLifecycleEvents(runner);
		this.lifecycleDispose = installWorkerLifecycle({ harness, session, runner, view, context: this.context,
			onCompactionPointer: (entryId, firstKeptEntryId) => view.setCompactionPointer(entryId, firstKeptEntryId),
			onBranchSummaryDetails: (entryId, details) => view.setBranchSummaryDetails(entryId, details),
			takeNavigationDecision: () => { const decision = this.navigationDecision; this.navigationDecision = undefined; return decision; },
			callerOwnsNavigationEvents: true,
		});
		await this.installToolSurface(runner);
		await runner.emit({ ...sessionStartEvent, reason });
		await this.flushActions();
		await this.extendResources(reason);		const name = await harness.getName(this.context);
		view.markName(name);
		if (this.options.name) await harness.setName(this.options.name, this.context);
		await this.installToolSurface(runner);
		await this.startQueueWatch();
	}

	private async readModelEntry(session: HarnessSession<AgentSessionMetadata>): Promise<WorkerModelChoice | undefined> {
		const configured = await session.getValue(laneConfig(MAIN_LANE), this.context);
		if (configured) return { ...configured.value.model, thinkingLevel: configured.value.thinkingLevel };
		const branch = await session.branch(MAIN_LANE, this.context);
		if (!branch) return undefined;
		const entries = await branch.findEntries(
			{ type: "custom", customType: META_CUSTOM_TYPE, order: "newestFirst", limit: 1 },
			this.context,
		);
		const entry = entries[0];
		if (entry?.type !== "custom") return undefined;
		const data = entry.data as { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel } | undefined;
		if (!data?.provider || !data.modelId) return undefined;
		return {
			provider: data.provider,
			modelId: data.modelId,
			...(data.thinkingLevel ? { thinkingLevel: data.thinkingLevel } : {}),
		};
	}

	private async extendResources(reason: "startup" | "reload"): Promise<void> {
		const loader = this.resourceLoader;
		if (!loader) throw new Error("agent resource loader is not attached");
		const paths = await this.requireRunner().emitResourcesDiscover(this.cwd, reason);
		const resourcePaths = (entries: Array<{ path: string; extensionPath: string }>) => entries.map((entry) => ({ path: entry.path, metadata: {
			source: `extension:${entry.extensionPath.startsWith("<") ? entry.extensionPath.replace(/[<>]/gu, "") : basename(entry.extensionPath).replace(/\.(ts|js)$/u, "")}`,
			scope: "temporary" as const, origin: "top-level" as const,
			...(entry.extensionPath.startsWith("<") ? {} : { baseDir: dirname(entry.extensionPath) }),
		} }));
		loader.extendResources({ skillPaths: resourcePaths(paths.skillPaths), promptPaths: resourcePaths(paths.promptPaths), themePaths: resourcePaths(paths.themePaths) });
		this.inputResources = { skills: loader.getSkills().skills, promptTemplates: loader.getPrompts().prompts };
		this.harnessResources = {
			skills: this.inputResources.skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath, content: readFileSync(skill.filePath, "utf8"), disableModelInvocation: skill.disableModelInvocation })),
			promptTemplates: this.inputResources.promptTemplates.map((prompt) => ({ name: prompt.name, description: prompt.description, content: prompt.content })),
		};
		await this.requireHarness().setResources(this.harnessResources, this.context);
	}

	private async reload(): Promise<void> {
		const session = this.session;
		if (!session) throw new Error("agent session is not attached");
		const metadata = session.metadata;
		await this.requireLane().waitForIdle(this.context);
		const runner = this.requireRunner();
		await this.close("reload");
		runner.invalidate();
		const reopened = await this.options.store.open(metadata, this.context);
		try { await this.attachToSession(reopened, metadata, "reload"); }
		catch (error) { await this.closeFailedStartup(reopened, error); throw error; }
	}

	private agentContextFiles: Array<{ path: string; content: string }> = [];
	private harnessResources: { skills?: Skill[]; promptTemplates?: Array<{ name: string; description?: string; content: string }> } = {};

	private systemPromptText(): string {
		return this.currentPrompt?.() ?? this.basePrompt;
	}

	private async refreshBasePrompt(): Promise<void> {
		this.basePrompt = (await renderWorkerPrompt(this.systemPromptOptions(), this.requireView() as never, this.options.modelRuntime)).read();
	}

	private systemPromptOptions(): BuildSystemPromptOptions {
		return {
			cwd: this.cwd,
			customPrompt: this.resourceLoader?.getSystemPrompt(),
			selectedTools: [...this.activeToolNames],
			toolSnippets: Object.fromEntries([...this.definitions.values()].flatMap(({ definition }) => definition.promptSnippet ? [[definition.name, definition.promptSnippet]] : [])),
			toolGuidelines: Object.fromEntries([...this.definitions.values()].flatMap(({ definition }) => definition.promptGuidelines ? [[definition.name, [...definition.promptGuidelines]]] : [])),
			appendSystemPrompt: this.resourceLoader?.getAppendSystemPrompt().join("\n\n"),
			contextFiles: this.agentContextFiles.map((file) => ({ ...file })),
			skills: this.inputResources.skills.map((skill) => ({ ...skill })),
		};
	}

	private requireLane(): AgentLane {
		if (!this.lane) throw new Error("agent session not attached");
		return this.lane;
	}

	private requireHarness(): Awaited<ReturnType<typeof AgentHarness.create>>["harness"] {
		if (!this.harness) throw new Error("agent session harness not attached");
		return this.harness;
	}

	private requireRunner(): ExtensionRunner {
		if (!this.runner) throw new Error("agent session runner not attached");
		return this.runner;
	}

	private requireView(): SessionView {
		if (!this.view) throw new Error("agent session view not attached");
		return this.view;
	}

	private onSessionEvent<TType extends HarnessEvent["type"]>(
		type: TType,
		listener: (event: Extract<HarnessEvent, { type: TType }>) => void | Promise<void>,
	): () => void {
		return this.requireHarness().events.on(type, async (event) => {
			const typed = event as Extract<HarnessEvent, { type: TType }>;
			if (
				"lane" in typed &&
				(typed as { lane?: string }).lane !== undefined &&
				(typed as { lane?: string }).lane !== MAIN_LANE
			) {
				return;
			}
			await listener(typed);
		});
	}

	private async guardedEmit(runner: ExtensionRunner, event: Record<string, unknown>): Promise<void> {
		if (!runner.hasHandlers(String(event.type))) return;
		await runner.emit(event as never);
	}

	private readonly definitions = new Map<string, RegisteredTool>();

	private async buildToolset(): Promise<Array<AgentHarnessTool<HostToolContext>>> {
		const settings = SettingsManager.create(this.cwd, this.agentDir);
		const builtins: ToolDefinition<any, any, any>[] = [
			createBashToolDefinition(this.cwd, { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() }),
			createReadToolDefinition(this.cwd, { autoResizeImages: settings.getImageAutoResize() }),
			createWriteToolDefinition(this.cwd), createEditToolDefinition(this.cwd),
			createFindToolDefinition(this.cwd), createGrepToolDefinition(this.cwd),
			createLsToolDefinition(this.cwd), createPowerShellToolDefinition(this.cwd),
		];
		this.definitions.clear();
		for (const definition of builtins) this.definitions.set(definition.name, { definition, sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }) });
		const runner = this.requireRunner();
		for (const registered of runner.getAllRegisteredTools()) this.definitions.set(registered.definition.name, registered);
		return [...this.definitions.values()].map(({ definition }) => ({
			name: definition.name, label: definition.label, description: definition.description, parameters: definition.parameters,
			execute: async (toolCallId, params, onUpdate) => {
				const ctx = runner.createContext();
				return definition.execute(toolCallId, params, ctx.signal, onUpdate, ctx);
			},
		} satisfies AgentHarnessTool<HostToolContext>));
	}

	private async installToolSurface(runner: ExtensionRunner): Promise<void> {
		const previous = new Set(this.toolset.map((tool) => tool.name));
		this.toolset = await this.buildToolset();
		this.toolInfos = [...this.definitions.values()].map(({ definition, sourceInfo }) => ({ name: definition.name, description: definition.description, parameters: definition.parameters, promptGuidelines: definition.promptGuidelines, sourceInfo }));
		const extensionNames = new Set(runner.getAllRegisteredTools().map((tool) => tool.definition.name));
		this.activeToolNames = this.toolset.filter((tool) => this.restoredToolNames !== undefined
			? this.restoredToolNames.includes(tool.name)
			: previous.size === 0 ? CORE_TOOL_NAMES.has(tool.name) || extensionNames.has(tool.name)
			: this.activeToolNames.includes(tool.name) || !previous.has(tool.name)).map((tool) => tool.name);
		this.restoredToolNames = undefined;
		await this.requireHarness().setTools(this.toolset, this.context);
		await this.requireLane().setActiveTools(this.activeToolNames, this.context);
		await this.refreshBasePrompt();
	}

	/** Tool-call/tool-result interception through the ordinary extension runner. */
	private installInterception(runner: ExtensionRunner): void {
		this.requireHarness().hooks.on("before_tool", (async (event: {
			toolCallId: string;
			toolName: string;
			args: Record<string, never>;
		}) => {
			if (!runner.hasHandlers("tool_call")) return undefined;
			const callEvent = toolNameToCallEvent(event.toolName, event.toolCallId, event.args as Record<string, unknown>);
			const result = await runner.emitToolCall(callEvent);
			if (result?.block) return { block: { reason: result.reason, terminate: result.terminate } };
			if (callEvent.input !== event.args) return { args: callEvent.input };
			return undefined;
		}) as never);
		this.requireHarness().hooks.on("after_tool", (async (event: {
			toolCallId: string;
			toolName: string;
			args: Record<string, never>;
			content: AgentToolResult<unknown>["content"];
			details?: unknown;
			isError: boolean;
			usage?: unknown;
		}) => {
			if (!runner.hasHandlers("tool_result")) return undefined;
			const resultEvent = toolNameToResultEvent(
				event.toolName,
				event.toolCallId,
				event.args as Record<string, unknown>,
				{
					content: event.content,
					details: event.details,
					isError: event.isError,
					usage: event.usage,
				},
			);
			const result = await runner.emitToolResult(resultEvent);
			if (!result) return undefined;
			return {
				content: result.content,
				details: result.details,
				isError: result.isError,
				usage: result.usage,
			};
		}) as never);
	}

	/** Provider/context hook mapping onto the ordinary extension event vocabulary. */
	private installProviderHooks(runner: ExtensionRunner): void {
		const hooks = this.requireHarness().hooks;
		hooks.on("before_navigation", (event) => {
			if (this.branchInstructions !== undefined) this.branchPrompt = `<conversation>\n${serializeConversation(convertToLlm(event.preparation.messages))}\n</conversation>\n\n${this.branchInstructions}`;
			return undefined;
		});
		hooks.on("before_request", (event) => { this.branchRequest = event.step === "branch_summary"; return undefined; });
		let runOptions: NormalizedBuildSystemPromptOptions | undefined;
		let promptRunId: string | undefined;
		const address = RUN_PROMPT;
		hooks.on("before_drive", async (event) => {
			if (event.operation !== "run" || promptRunId === event.runId) return;
			runOptions = undefined;
			this.currentPrompt = undefined;
			const stored = await this.session!.getValue(address, this.context);
			if (stored?.value.runId !== event.runId) {
				const state = (await this.session!.getValue(operationState(event.runId), this.context))?.value;
				if (state?.at !== "starting") throw new Error("The active run has no recorded prompt state; resume cannot reconstruct missing hook state");
				return;
			}
			const restored = await renderWorkerPrompt({ ...stored.value.options, selectedTools: [...this.activeToolNames] }, this.requireView() as never, this.options.modelRuntime);
			runOptions = restored.options;
			this.currentPrompt = restored.read;
			promptRunId = event.runId;
		});
		hooks.on("before_run", async (event) => {
			runOptions = undefined;
			this.currentPrompt = undefined;
			const prompt = event.prompt.map(textContentOf).filter(Boolean).join("\n");
			await this.flushActions();
			const options = this.systemPromptOptions();
			const selectedBefore = options.selectedTools ?? [];
			const result = await runner.emitBeforeAgentStart(prompt, imagesOf(event.prompt), options);
			await this.flushActions();
			const selected = result.systemPromptOptions.selectedTools;
			const edited = selected.length !== selectedBefore.length || selected.some((name, index) => name !== selectedBefore[index]);
			result.systemPromptOptions.selectedTools = [...new Set(edited ? selected : this.activeToolNames)].filter((name) => this.definitions.has(name));
			await this.setActiveToolsAction(result.systemPromptOptions.selectedTools);
			await this.session!.mutate(async (mutator, context) => { await mutator.commit([setValue(address, { runId: event.runId, options: result.systemPromptOptions })], context); }, this.context);
			runOptions = result.systemPromptOptions;
			this.currentPrompt = () => this.promptObserver.read();
			promptRunId = event.runId;
			const injected: AgentMessage[] = (result.messages ?? []).map((message) => ({ role: "custom", ...message, timestamp: Date.now() }));
			return injected.length ? { messages: injected } : undefined;
		});
		hooks.on("transform_context", async (event) => {
			const messages = await runner.emitContext(event.messages);
			await this.flushActions();
			if (!runOptions || promptRunId !== event.runId) throw new Error("The active run has no recorded prompt state; start a new run instead of reconstructing missing hook state");
			const current = this.systemPromptOptions();
			runOptions.selectedTools = [...this.activeToolNames];
			runOptions.toolSnippets = { ...current.toolSnippets, ...runOptions.toolSnippets };
			runOptions.toolGuidelines = { ...current.toolGuidelines, ...runOptions.toolGuidelines };
			// The lane supplies current prompt and tools separately. Replaying source
			// declarations after that head would restore the source's old loadout.
			return { messages: messages.filter((message) => message.role !== "system"), systemPrompt: this.systemPromptText() };
		});
		hooks.on("before_payload", async (event) => ({ payload: await runner.emitBeforeProviderRequest(event.payload) }));
	}

	/** Map harness lifecycle events to the extension event vocabulary. Handler errors stay inside runner.emit (emitError). */
	private installLifecycleEvents(runner: ExtensionRunner): void {
		const emit = (event: Record<string, unknown>): Promise<void> => this.guardedEmit(runner, event);
		let turnIndex = 0;
		this.onSessionEvent("entry_added", (event) => {
			this.options.onUpdate?.({ kind: "entry", lane: MAIN_LANE, entry: event.entry });
		});
		this.onSessionEvent("run_start", async () => {
			this.busy = true;
			turnIndex = 0;
			this.operationController = new AbortController();
			this.currentSignal = this.operationController.signal;
			await emit({ type: "agent_start" });
		});
		this.onSessionEvent("operation_abort", async () => {
			this.operationController?.abort();
		});
		this.onSessionEvent("turn_start", async () => {
			await emit({ type: "turn_start", turnIndex: turnIndex, timestamp: Date.now() });
		});
		this.onSessionEvent("turn_end", async (event) => {
			const typed = event as { message?: AgentMessage; toolResults?: unknown };
			await emit({ type: "turn_end", turnIndex, message: typed.message, toolResults: typed.toolResults });
			turnIndex += 1;
		});
		this.onSessionEvent("message_start", async (event) =>
			emit({ type: "message_start", message: (event as { message: AgentMessage }).message }),
		);
		this.onSessionEvent("message_update", async (event) => {
			const typed = event as { message: AgentMessage; event?: unknown };
			await emit({ type: "message_update", message: typed.message, assistantMessageEvent: typed.event });
		});

		this.onSessionEvent("tool_start", async (event) => {
			const typed = event as { toolCallId: string; toolName: string; args: unknown };
			await emit({ type: "tool_execution_start", toolCallId: typed.toolCallId, toolName: typed.toolName, args: typed.args });
		});
		this.onSessionEvent("tool_update", async (event) => {
			const typed = event as { toolCallId: string; toolName: string; partialResult: unknown };
			await emit({
				type: "tool_execution_update",
				toolCallId: typed.toolCallId,
				toolName: typed.toolName,
				args: undefined,
				partialResult: typed.partialResult,
			});
		});
		this.onSessionEvent("tool_end", async (event) => {
			const typed = event as { toolCallId: string; toolName: string; result: unknown; isError: boolean };
			await emit({
				type: "tool_execution_end",
				toolCallId: typed.toolCallId,
				toolName: typed.toolName,
				result: typed.result,
				isError: typed.isError,
			});
		});

		this.onSessionEvent("run_end", async (event) => {
			const typed = event;
			this.options.onUpdate?.({ kind: "operation", lane: MAIN_LANE, operationId: typed.runId, status: typed.status });
			this.busy = false;
			this.operationController = undefined;
			this.currentSignal = undefined;
			this.view?.setLeafFromHarness(typed.tipId ?? null);
			await emit({ type: "agent_end", messages: await this.collectRunMessages(typed.fromTipId, typed.tipId) });
			if (typed.status === "completed" || typed.status === "aborted" || typed.status === "failed") {
				await emit({ type: "agent_settled" });
			}
			void this.refreshQueueSnapshot();
		});
	}

	/** Model messages produced by one run: entries from tip back to (excluding) the pre-run tip. */
	private async collectRunMessages(fromTipId: string | null, tipId: string | null): Promise<AgentMessage[]> {
		if (!tipId) return [];
		const lane = this.requireLane();
		const entries = await lane.findEntries(
			fromTipId ? { order: "newestFirst", stopAtId: fromTipId } : { order: "newestFirst", limit: 100 },
			this.context,
		);
		const messages = entries
			.filter((entry) => entry.type === "message" && entry.id !== fromTipId)
			.map((entry) => (entry as { message: AgentMessage }).message);
		return messages.reverse();
	}

	private queueAction(action: Promise<unknown>): void {
		this.pendingActions.add(action);
		void action.catch((error) => { this.lastError = String(error); }).finally(() => this.pendingActions.delete(action));
	}

	private async flushActions(): Promise<void> {
		while (this.pendingActions.size) await Promise.all([...this.pendingActions]);
	}

	private bindExtensionActions(runner: ExtensionRunner): void {
		const lane = this.requireLane();
		const harness = this.requireHarness();
		const actions: ExtensionActions = {
			sendMessage: (message, options) => {
				this.queueAction(this.deliverCustomMessage(message, options));
			},
			sendUserMessage: (content, options) => {
				this.queueAction(this.sendUserMessage(content, options));
			},
			appendEntry: (customType, data) => {
				this.queueAction(lane.appendCustomEntry(customType, data as never, this.context));
			},
			setSessionName: (name) => {
				this.requireView().markName(name);
				this.queueAction(this.setSessionName(name));
			},
			getSessionName: () => this.requireView().getSessionName(),
			setLabel: (entryId, label) => {
				this.requireView().markLabel(entryId, label);
				this.queueAction((async () => {
					await harness.setLabel(entryId, label, this.context);
					if (label === undefined) {
						await lane.appendCustomEntry(LABEL_CHANGE_ENTRY_TYPE, { targetId: entryId }, this.context);
					} else {
						await lane.appendCustomEntry(LABEL_CHANGE_ENTRY_TYPE, { targetId: entryId, label }, this.context);
					}
				})());
			},
			getActiveTools: () => [...this.activeToolNames],
			getAllTools: (): ToolInfo[] => this.toolInfos.map((info) => ({ ...info })),
			setActiveTools: (names) => {
				this.activeToolNames = [...names];
				this.queueAction(this.setActiveToolsAction(names));
			},
			refreshTools: () => {
				this.queueAction(this.installToolSurface(runner));
			},
			getCommands: () =>
				runner.getRegisteredCommands().map((command) => ({
					name: command.name,
					...(command.description === undefined ? {} : { description: command.description }),
					source: "extension" as const,
					sourceInfo: command.sourceInfo,
				})),
			setModel: (model) => this.setModelAction(model.provider, model.id),
			getThinkingLevel: () => this.currentThinkingLevel(),
			setThinkingLevel: (level) => { this.queueAction(this.setThinkingLevelAction(level)); },
		};
		const contextActions: ExtensionContextActions = {
			getModel: () => this.currentModel(),
			getScopedModels: () => [],
			isIdle: () => !this.busy,
			isProjectTrusted: () => this.isProjectTrusted(),
			getSignal: () => this.currentSignal,
			abort: () => {
				void this.abort().catch(() => undefined);
			},
			hasPendingMessages: () => this.queueCount() > 0,
			shutdown: () => {
				void this.close().catch(() => undefined);
			},
			getContextUsage: () => this.computeContextUsage(),
			compact: (options) => {
				this.queueAction(this.compact(options?.customInstructions).then((result) => { options?.onComplete?.(result); }).catch((error) => {
					if (options?.onError) options.onError(error instanceof Error ? error : new Error(String(error)));
					else throw error;
				}));
			},
			getSystemPrompt: () => this.systemPromptText(),
			getSystemPromptOptions: () => this.systemPromptOptions(),
		};
		runner.bindCore(actions, contextActions, {
			registerProvider: (name, config) => this.options.modelRuntime.registerProvider(name, config),
			registerNativeProvider: (provider) => this.options.modelRuntime.registerNativeProvider(provider),
			unregisterProvider: (name) => this.options.modelRuntime.unregisterProvider(name),
		});
	}

	/** Deliver one extension custom message: queue it as model input when deliverAs is set, otherwise record the wrapped durable entry and optionally trigger a turn. */
	async deliverCustomMessage(
		message: { customType: string; content: string | ContentPart[]; display?: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const lane = this.requireLane();
		if (options?.deliverAs === "steer" || options?.deliverAs === "followUp" || options?.deliverAs === "nextTurn") {
			const message0 = { role: "custom", customType: message.customType, content: message.content, display: message.display ?? false, details: message.details, timestamp: Date.now() } as AgentMessage;
			if (options.deliverAs === "steer") await lane.steer(message0, undefined, this.context);
			else if (options.deliverAs === "followUp") await lane.followUp(message0, undefined, this.context);
			else await lane.nextRun(message0, undefined, this.context);
			void this.refreshQueueSnapshot();
			return;
		}
		if (options?.triggerTurn) {
			await this.admitPrompt({ role: "custom", customType: message.customType, content: message.content, display: message.display ?? false, details: message.details, timestamp: Date.now() } as AgentMessage);
			return;
		}
		await lane.appendCustomEntry(
			CUSTOM_MESSAGE_WRAPPER_TYPE,
			{
				customType: message.customType,
				content: message.content,
				...(message.display === undefined ? {} : { display: message.display }),
				...(message.details === undefined ? {} : { details: message.details }),
			} as never,
			this.context,
		);
	}

	private currentThinkingLevel(): ThinkingLevel {
		return this.modelChoice?.thinkingLevel ?? "off";
	}

	private currentModel(): ReturnType<NonNullable<ExtensionContextActions["getModel"]>> {
		if (!this.modelChoice) return undefined;
		return this.options.modelRuntime.getModel(this.modelChoice.provider, this.modelChoice.modelId);
	}

	/** Ordinary context-usage estimate over the current branch (last assistant usage + trailing estimate). */
	private computeContextUsage(): ContextUsageShape | undefined {
		const model = this.currentModel();
		const contextWindow = model?.contextWindow ?? 0;
		if (!model || contextWindow <= 0) return undefined;
		const branch = this.requireView().getBranch();
		const messages: SessionMessageEntry[] = branch.filter(
			(entry): entry is SessionMessageEntry => entry.type === "message",
		);
		let latestCompactionIndex = -1;
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			if (branch[index].type === "compaction") {
				latestCompactionIndex = index;
				break;
			}
		}
		if (latestCompactionIndex >= 0) {
			const postCompactionUsage = getLastAssistantUsage(
				branch.slice(latestCompactionIndex + 1).filter((entry): entry is SessionMessageEntry => entry.type === "message"),
			);
			if (postCompactionUsage === undefined || calculateContextTokens(postCompactionUsage) <= 0) {
				return { tokens: null, contextWindow, percent: null };
			}
		}
		const usage = getLastAssistantUsage(messages);
		let tokens = 0;
		if (usage) {
			tokens = calculateContextTokens(usage);
		}
		const usageMessageIndex = (() => {
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (getLastAssistantUsage([messages[index]]) === usage && usage !== undefined) return index;
			}
			return -1;
		})();
		for (let index = usageMessageIndex + 1; index < messages.length; index += 1) {
			tokens += estimateTokens(messages[index].message);
		}
		return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
	}

	private async startQueueWatch(): Promise<void> {
		const lane = this.requireLane();
		const handle = await lane.watch(this.context);
		const state = { handle, snapshot: handle.snapshot, refreshing: false };
		this.laneWatcher = state;
		handle.start(() => {
			void this.refreshQueueSnapshot();
		});
	}

	private async refreshQueueSnapshot(): Promise<void> {
		const state = this.laneWatcher;
		if (!state || state.refreshing) return;
		state.refreshing = true;
		try {
			state.snapshot = await state.handle.resnapshot(this.context);
		} catch {
			// Keep the last good snapshot; queue reads are advisory.
		} finally {
			state.refreshing = false;
		}
	}

	private queueCount(): number {
		return this.laneWatcher?.snapshot.queues.length ?? 0;
	}

	/** Admit one prompt and drive it in the background; resolves as soon as the operation is admitted. */
	async start(prompt: string | AgentMessage, images?: ImageContent[]): Promise<string | undefined> {
		await this.flushActions();
		if (typeof prompt !== "string") return this.admitPrompt(prompt);
		if (prompt.startsWith("!")) {
			if (this.bashController) throw new Error("A user bash command is already active");
			const controller = new AbortController();
			this.bashController = controller;
			const settings = SettingsManager.create(this.cwd, this.agentDir);
			try {
				const excludeFromContext = prompt.startsWith("!!");
				this.bashTask = executeWorkerBash({ runner: this.requireRunner(), cwd: this.cwd, command: prompt.slice(excludeFromContext ? 2 : 1), excludeFromContext, signal: controller.signal, shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix(), outputDirectory: join(this.options.store.root, "bash-output") });
				const message = await this.bashTask;
				if (this.busy) this.pendingBashMessages.push(message);
				else await this.requireLane().appendMessage(message, this.context);
			} finally { this.bashController = undefined; this.bashTask = undefined; }
			return undefined;
		}
		const prepared = await prepareWorkerInput(this.requireRunner(), { text: prompt, images, source: "interactive", streaming: () => this.busy }, this.inputResources, async (text) => {
			const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
			if (match) await this.runCommand(match[1], match[2] ?? "");
		});
		if (prepared.kind === "handled") return undefined;
		return this.admitPrompt(contentToAgentMessage(prepared.images?.length ? [{ type: "text", text: prepared.text }, ...prepared.images] : prepared.text));
	}

	private async admitPrompt(prompt: string | AgentMessage): Promise<string> {
		const lane = this.requireLane();
		const admission = await lane.accept(
			{ kind: "prompt", prompt } as never,
			this.context,
		);
		if (!admission.ok) {
			const detail = (admission.error as { message?: string }).message;
			throw new Error(`agent session lane rejected the prompt (${admission.error._tag}${detail ? `: ${detail}` : ""})`);
		}
		this.busy = true;
		this.driveTask = this.driveAdmitted(admission.value.operationId);
		void this.driveTask;
		return admission.value.operationId;
	}

	private async driveAdmitted(operationId: string): Promise<void> {
		try {
			await this.requireLane().drive({ operationId, waitForRetry: true }, this.context);
			for (const message of this.pendingBashMessages.splice(0)) await this.requireLane().appendMessage(message, this.context);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.options.onUpdate?.({ kind: "error", lane: MAIN_LANE, message: this.lastError });
		}
	}

	async sendUserMessage(
		content: string | ContentPart[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		const input = normalizeWorkerUserContent(content as Parameters<typeof normalizeWorkerUserContent>[0]);
		const prepared = await prepareWorkerInput(this.requireRunner(), { ...input, source: "extension", expandPromptTemplates: options?.expandPromptTemplates ?? false, streaming: () => this.busy, streamingBehavior: options?.deliverAs }, this.inputResources, async (text) => {
			const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
			if (match) await this.runCommand(match[1], match[2] ?? "");
		});
		if (prepared.kind === "handled") return;
		const message = contentToAgentMessage(prepared.images?.length ? [{ type: "text", text: prepared.text }, ...prepared.images] : prepared.text);
		if (prepared.streamingBehavior === "steer") await this.requireLane().steer(message, undefined, this.context);
		else if (prepared.streamingBehavior === "followUp") await this.requireLane().followUp(message, undefined, this.context);
		else await this.admitPrompt(message);
		await this.refreshQueueSnapshot();
	}

	async appendCustomEntry(customType: string, data: unknown): Promise<void> {
		await this.requireLane().appendCustomEntry(customType, data as never, this.context);
	}

	setOnUpdate(onUpdate?: (update: WorkerUpdate) => void): void {
		this.options.onUpdate = onUpdate;
	}

	async steer(text: string, images?: ImageContent[]): Promise<string> {
		const prepared = prepareWorkerQueuedInput(this.requireRunner(), { text, images }, this.inputResources);
		const result = await this.requireLane().steer(prepared.text, prepared.images, this.context);
		if (!result.ok) throw new Error(`Steering failed: ${result.error._tag}`);
		void this.refreshQueueSnapshot();
		return result.value.entryId;
	}

	async abort(): Promise<boolean> {
		let aborted = false;
		if (this.bashController) {
			this.bashController.abort();
			aborted = true;
		}
		if (this.navigationController) {
			this.navigationController.abort();
			aborted = true;
		}
		// The lane abort requests cancellation and drives it. A plain request
		// leaves a restored or suspended operation waiting without a driver, so
		// the operation never settles and shutdown waits forever.
		const result = await this.requireLane().abort(this.context);
		if (result.ok) return true;
		if (result.error._tag === "NoActiveOperation") return aborted;
		throw result.error;
	}

	async status(): Promise<WorkerStatus> {
		const harness = this.requireHarness();
		const lane = this.requireLane();
		const execution = await lane.inspectExecution(this.context);
		const thinkingLevel = await lane.getThinkingLevel(this.context);
		return {
			sessionId: this.sessionId(),
			cwd: this.cwd,
			name: (await harness.getName(this.context)) ?? undefined,
			lane: MAIN_LANE,
			tipId: await lane.getTipId(this.context),
			model: { provider: execution.configuredModel.provider, modelId: execution.configuredModel.modelId, thinkingLevel: thinkingLevel ?? "off" },
			operation: execution.current?.id ?? null,
			tools: this.toolset.map((tool) => tool.name),
			activeTools: this.activeToolNames,
			extensions: (this.extensionsResult?.extensions ?? []).map((extension) => extension.path),
			entryCount: this.requireView().getEntries().length,
			...(this.lastError ? { lastError: this.lastError.slice(0, 2000) + (this.lastError.length > 2000 ? " [truncated]" : "") } : {}),
		};
	}

	async inspect(options: { cursor?: number; limit?: number; entryId?: string; offset?: number } = {}) {
		const lane = this.requireLane();
		const execution = await lane.inspectExecution(this.context);
		const result = execution.lastOperationId ? await lane.getResult(execution.lastOperationId, this.context) : undefined;
		if (options.entryId) {
			const entry = (await this.session!.getEntries([options.entryId], this.context)).get(options.entryId);
			if (!entry) throw new Error(`no entry ${options.entryId} in session ${this.sessionId()}`);
			const text = JSON.stringify(entry);
			const offset = Math.max(0, options.offset ?? 0);
			return { sessionId: this.sessionId(), execution, lastError: this.lastError ? textFragment(this.lastError, 0, 2400) : undefined, entryId: entry.id, offset, ...textFragment(text, offset, 12000) };
		}
		const limit = Math.max(1, Math.min(12, options.limit ?? 6));
		const found = await lane.findEntries({ order: "newestFirst", limit: limit + 1, ...(options.cursor === undefined ? {} : { cursor: { seq: options.cursor } }) }, this.context);
		const entries = found.slice(0, limit).map((entry) => {
			const text = JSON.stringify(entry);
			return { id: entry.id, parentId: entry.parentId, seq: entry.seq, type: entry.type, role: entry.type === "message" ? entry.message.role : undefined, ...textFragment(text, 0, 1200) };
		});
		return { sessionId: this.sessionId(), execution, lastError: this.lastError ? textFragment(this.lastError, 0, 2400) : undefined, result: result ? { operationId: result.operationId, ...textFragment(JSON.stringify(result), 0, 2400) } : undefined, entries, nextCursor: found.length > limit ? entries.at(-1)?.seq : null, order: "newestFirst", detail: "Use entryId and offset for the complete serialized entry." };
	}

	/** Host-owned work also blocks an idle-only ownership transfer. */
	hasPendingHostWork(): boolean {
		return this.busy || !!this.bashTask || !!this.navigationController || this.pendingActions.size > 0 || this.queueCount() > 0;
	}

	/** Retrieve the outcome of one admitted operation without substituting a later result. */
	async operationResult(operationId: string) {
		return this.requireLane().getResult(operationId, this.context);
	}

	lastErrorMessage(): string | undefined {
		return this.lastError;
	}

	/**
	 * Resolve when the admitted operation and host actions stop. Queued input
	 * can remain after lane idle; callers that require an empty queue must
	 * inspect a fresh lane snapshot. Unlike close(), this does not abort work.
	 */
	async waitForIdle(): Promise<void> {
		await this.driveTask;
		await this.flushActions();
		if (this.lane) await this.lane.waitForIdle(this.context);
	}

	close(reason = "quit"): Promise<void> {
		if (!this.closeTask) this.closeTask = this.closeHost(reason);
		return this.closeTask;
	}

	private async closeHost(reason: string): Promise<void> {
		const sessionId = this.session?.metadata.id;
		const errors: unknown[] = [];
		const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
		this.bashController?.abort();
		await attempt(async () => this.bashTask);
		if (this.lane) await attempt(() => this.abort());
		await attempt(async () => this.driveTask);
		if (this.lane) await attempt(() => this.lane!.waitForIdle(this.context));
		const runner = this.runner;
		this.runner = undefined;
		if (runner) await attempt(() => runner.emit({ type: "session_shutdown", reason } as never));
		await attempt(() => this.flushActions());
		await attempt(async () => this.lifecycleDispose?.());
		this.lifecycleDispose = undefined;
		for (const watch of this.laneObservers) await attempt(async () => watch.unsubscribe());
		this.laneObservers.clear();
		await attempt(async () => this.laneWatcher?.handle.unsubscribe());
		this.laneWatcher = undefined;
		if (this.harness) await attempt(() => this.harness!.close(this.context));
		if (this.session) await attempt(() => this.session!.close(this.context));
		this.harness = undefined;
		this.session = undefined;
		this.lane = undefined;
		if (sessionId) await attempt(async () => this.options.onSessionClosed?.(sessionId));
		if (errors.length) throw new AggregateError(errors, "agent session cleanup failed");
	}

	private readonly laneObservers = new Set<Awaited<ReturnType<AgentLane["watch"]>>>();

	async observeLane(): Promise<{
		snapshot: LaneSnapshot;
		subscribe(listener: (event: HarnessEvent) => void): () => void;
		resnapshot(): Promise<LaneSnapshot>;
	}> {
		const watch = await this.requireLane().watch(this.context);
		this.laneObservers.add(watch);
		return {
			snapshot: watch.snapshot,
			subscribe: (listener) => {
				// WatchHandle buffers events until start; never drain before the
				// observer has installed its recipient.
				watch.start(listener);
				return () => { watch.unsubscribe(); this.laneObservers.delete(watch); };
			},
			resnapshot: () => watch.resnapshot(this.context),
		};
	}

	/** Resume one suspended operation; reports whether the lane had one. */
	async resume(): Promise<boolean> {
		const lane = this.requireLane();
		const active = (await lane.inspectExecution(this.context)).current;
		if (active?.kind === "run") {
			const state = (await this.session!.getValue(operationState(active.id), this.context))?.value;
			const stored = await this.session!.getValue(RUN_PROMPT, this.context);
			if (state?.at !== "starting" && stored?.value.runId !== active.id) throw new Error("The active run has no recorded prompt state; resume cannot reconstruct missing hook state");
		}
		const result = await lane.resume(this.context);
		if (result.ok) return true;
		if (result.error._tag === "NothingToResume") return false;
		throw result.error;
	}

	async compact(customInstructions?: string) {
		const result = await this.requireLane().compact(customInstructions ? { customInstructions } : undefined, this.context);
		if (!result.ok) throw new Error(`Compaction failed: ${result.error._tag}`);
		if (result.value.compaction.status !== "completed") throw new Error(`Compaction ${result.value.compaction.status}`);
		const entry = result.value.compaction.tipId ? this.requireView().getEntry(result.value.compaction.tipId) : undefined;
		if (entry?.type !== "compaction") throw new Error("The completed compaction entry is unavailable");
		return { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore, details: entry.details, usage: entry.usage };
	}

	async setSessionName(name: string | undefined): Promise<void> {
		await this.requireHarness().setName(name, this.context);
		await this.requireLane().appendCustomEntry(NAME_CHANGE_ENTRY_TYPE, name === undefined ? {} : { name }, this.context);
		this.requireView().markName(name);
	}

	/** Seed a naked durable branch before the runtime takes ownership of its tip. */
	private async seedSetup(session: HarnessSession<AgentSessionMetadata>, manager: SessionManager): Promise<void> {
		const entries = manager.getEntries();
		const writes: Write[] = [];
		for (const entry of entries) {
			const base = { id: entry.id, parentId: entry.parentId };
			const custom = (customType: string, data: unknown): void => {
				writes.push(insertEntry({ ...base, type: "custom", customType, data: data as never }));
			};
			switch (entry.type) {
				case "message":
					writes.push(insertEntry({ ...base, type: "message", message: entry.message }));
					break;
				case "custom": custom(entry.customType, entry.data); break;
				case "custom_message":
					custom(CUSTOM_MESSAGE_WRAPPER_TYPE, { customType: entry.customType, content: entry.content, display: entry.display, ...(entry.details === undefined ? {} : { details: entry.details }) });
					break;
				case "label":
					custom(LABEL_CHANGE_ENTRY_TYPE, { targetId: entry.targetId, ...(entry.label === undefined ? {} : { label: entry.label }) });
					break;
				case "session_info": custom(NAME_CHANGE_ENTRY_TYPE, { ...(entry.name === undefined ? {} : { name: entry.name }) }); break;
				case "model_change": custom(MODEL_CHANGE_ENTRY_TYPE, { provider: entry.provider, modelId: entry.modelId }); break;
				case "thinking_level_change": custom(THINKING_CHANGE_ENTRY_TYPE, { thinkingLevel: entry.thinkingLevel }); break;
				case "branch_summary":
					writes.push(insertEntry({ ...base, type: "branch_summary", fromId: entry.fromId, summary: entry.summary, fromHook: entry.fromHook ?? false, ...(entry.details === undefined ? {} : { details: entry.details as never }), ...(entry.usage ? { usage: entry.usage } : {}) }));
					break;
				case "compaction": {
					const ancestry = entry.parentId ? manager.getBranch(entry.parentId) : [];
					const index = ancestry.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
					const retainedTail = (index < 0 ? [] : ancestry.slice(index)).flatMap((candidate: SessionEntry) => {
						if (candidate.type === "custom_message") return [contentToAgentMessage(candidate.content)];
						return sessionEntryToContextMessages(candidate);
					});
					writes.push(insertEntry({ ...base, type: "compaction", summary: entry.summary, retainedTail, tokensBefore: entry.tokensBefore, fromHook: entry.fromHook ?? false, ...(entry.details === undefined ? {} : { details: entry.details as never }), ...(entry.usage ? { usage: entry.usage } : {}) }));
					// Preserve the ordinary pointer, including metadata-only kept entries,
					// independently of the runtime's message-only retained tail.
					writes.push(setValue(valueAddress<string>("agent.setup.first-kept", entry.id), entry.firstKeptEntryId));
					break;
				}
			}
		}
		for (const entry of entries) {
			const label = manager.getLabel(entry.id);
			if (label) writes.push(setValue(entryLabel(entry.id), label));
		}
		const name = manager.getSessionName();
		if (name !== undefined) writes.push(setValue(sessionName, name));
		writes.push(setValue(branchTip(MAIN_LANE), manager.getLeafId()));
		await session.mutate(async (mutator, context) => { await mutator.commit(writes, context); }, this.context);
		const selected = manager.buildSessionContext();
		if (selected.model && this.options.model) this.options.model = { ...this.options.model, ...selected.model };
		if (manager.getBranch().some((entry) => entry.type === "thinking_level_change") && this.options.model) {
			this.options.model = { ...this.options.model, thinkingLevel: selected.thinkingLevel as ThinkingLevel };
		}
	}

	private async navigateTree(targetId: string, options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {}): Promise<{ cancelled: boolean }> {
		if (this.navigationController) throw new Error("A tree navigation is already active");
		const view = this.requireView();
		if (!view.getEntry(targetId)) throw new Error(`Unknown tree entry ${targetId}`);
		const controller = new AbortController();
		this.navigationController = controller;
		try {
			const selected = collectEntriesForBranchSummary(view, view.getLeafId(), targetId);
			const preparation = { targetId, oldLeafId: view.getLeafId(), commonAncestorId: selected.commonAncestorId, entriesToSummarize: selected.entries, userWantsSummary: options.summarize ?? false, customInstructions: options.customInstructions, replaceInstructions: options.replaceInstructions, label: options.label };
			const result = await this.requireRunner().emit({ type: "session_before_tree", preparation, signal: controller.signal });
			if (result?.cancel || controller.signal.aborted) return { cancelled: true };
			const instructions = result?.customInstructions ?? preparation.customInstructions;
			this.branchInstructions = (result?.replaceInstructions ?? preparation.replaceInstructions) && instructions ? instructions : undefined;
			this.navigationDecision = result?.summary ? { summary: result.summary } : undefined;
			this.navigationLabel = result?.label ?? preparation.label;
			const navigation = await this.requireLane().navigateTree(targetId, { summarize: !!result?.summary || preparation.userWantsSummary, customInstructions: instructions }, this.context);
			if (!navigation.ok) throw new Error(`Tree navigation failed: ${navigation.error._tag}`);
			if (navigation.value.navigation.status !== "completed") return { cancelled: true };
			const tipId = navigation.value.navigation.tipId;
			const summaryEntry = tipId ? view.getEntry(tipId) : undefined;
			if (tipId && this.navigationLabel !== undefined) {
				await this.requireHarness().setLabel(tipId, this.navigationLabel, this.context);
				view.markLabel(tipId, this.navigationLabel);
				await this.requireLane().appendCustomEntry(LABEL_CHANGE_ENTRY_TYPE, { targetId: tipId, label: this.navigationLabel }, this.context);
			}
			await this.requireRunner().emit({ type: "session_tree", newLeafId: view.getLeafId(), oldLeafId: preparation.oldLeafId, ...(summaryEntry?.type === "branch_summary" ? { summaryEntry } : {}), fromExtension: !!result?.summary });
			return { cancelled: false };
		} finally { this.navigationDecision = undefined; this.navigationController = undefined; this.branchInstructions = undefined; this.branchPrompt = undefined; this.branchRequest = false; this.navigationLabel = undefined; }
	}

	async setModelAction(provider: string, modelId: string): Promise<boolean> {
		const model = this.options.modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`model ${provider}/${modelId} is not available`);
		const configured =
			this.options.modelRuntime.hasConfiguredAuth(provider) ||
			(await this.options.modelRuntime.checkAuth(provider)) !== undefined;
		if (!configured) return false;
		const previousModel = this.currentModel();
		const previousLevel = this.currentThinkingLevel();
		// The ordinary model-switch order: a per-model setting, then the global
		// default, then the current level. Clamp the result to the new model so
		// the lane never holds a level the model cannot run.
		const settings = SettingsManager.create(this.cwd, this.agentDir);
		const requested =
			settings.getModelThinkingLevel(provider, modelId) ?? settings.getDefaultThinkingLevel() ?? previousLevel;
		const effectiveLevel = clampThinkingLevel(model, requested);
		await this.requireLane().setModel({ provider, modelId }, this.context);
		this.modelChoice = { provider, modelId, thinkingLevel: effectiveLevel };
		if (effectiveLevel !== previousLevel) {
			await this.requireLane().setThinkingLevel(effectiveLevel, this.context);
			await this.requireLane().appendCustomEntry(THINKING_CHANGE_ENTRY_TYPE, { thinkingLevel: effectiveLevel }, this.context);
		}
		await this.requireLane().appendCustomEntry(MODEL_CHANGE_ENTRY_TYPE, { provider, modelId }, this.context);
		const runner = this.requireRunner();
		await this.guardedEmit(runner, { type: "model_select", model: this.currentModel(), previousModel, source: "set" });
		if (effectiveLevel !== previousLevel) {
			await this.guardedEmit(runner, { type: "thinking_level_select", level: effectiveLevel, previousLevel });
		}
		return true;
	}

	async setThinkingLevelAction(level: ThinkingLevel): Promise<ThinkingLevel> {
		const model = this.currentModel();
		const effective = model ? clampThinkingLevel(model, level) : level;
		const previousLevel = this.currentThinkingLevel();
		if (effective === previousLevel) return effective;
		await this.requireLane().setThinkingLevel(effective, this.context);
		if (this.modelChoice) {
			this.modelChoice = { provider: this.modelChoice.provider, modelId: this.modelChoice.modelId, thinkingLevel: effective };
		}
		await this.requireLane().appendCustomEntry(THINKING_CHANGE_ENTRY_TYPE, { thinkingLevel: effective }, this.context);
		await this.guardedEmit(this.requireRunner(), { type: "thinking_level_select", level: effective, previousLevel });
		return effective;
	}

	async setActiveToolsAction(names: string[]): Promise<void> {
		const known = new Set(this.toolset.map((tool) => tool.name));
		const accepted = names.filter((name) => known.has(name));
		await this.requireLane().setActiveTools(accepted, this.context);
		this.activeToolNames = accepted;
		await this.refreshBasePrompt();
	}

	/** Command context bound to this (replacement) session for lifecycle withSession callbacks. */
	createReplacedSessionContext(): ReplacedSessionContext {
		const runner = this.requireRunner();
		return Object.assign(runner.createCommandContext(), {
			sendMessage: async (...[message, options]: Parameters<ReplacedSessionContext["sendMessage"]>) => { await this.deliverCustomMessage(message, options); },
			sendUserMessage: async (...[content, options]: Parameters<ReplacedSessionContext["sendUserMessage"]>) => { await this.sendUserMessage(content, options); },
		}) satisfies ReplacedSessionContext;
	}

	/** Run one registered extension command in this session context; replacement flows report the new session id. */
	async runCommand(name: string, args: string): Promise<WorkerCommandResult> {
		if (name === "reload") { await this.reload(); return { text: "Session resources reloaded.", sessionId: this.sessionId() }; }
		if (name === "tree") {
			if (!args.trim()) return { text: this.requireView().getEntries().slice(-100).map((entry) => `${entry.id} parent=${entry.parentId ?? "root"} ${entry.type}`).join("\n") };
			const result = await this.navigateTree(args.trim());
			return { text: result.cancelled ? "Session branch selection cancelled." : "Session branch selected." };
		}
		const runner = this.requireRunner();
		const command = runner.getRegisteredCommands().find((candidate) => candidate.name === name);
		if (!command) throw new Error(`unknown command "${name}" in agent session ${this.sessionId()}`);
		const binding = this.bindCommands(runner);
		const ctx = runner.createCommandContext();
		await command.handler(args, ctx);
		await this.flushActions();
		const replacementId = binding.getReplacementId();
		return { text: "", ...(replacementId ? { sessionId: replacementId } : {}) };
	}

	private bindCommands(runner: ExtensionRunner) {
		let replacementId: string | undefined;
		runner.bindCommandContext({
			waitForIdle: () => this.requireLane().waitForIdle(this.context),
			navigateTree: (targetId, options) => this.navigateTree(targetId, options ?? undefined),
			reload: async () => {
				await this.reload();
				replacementId = this.sessionId();
			},
			newSession: async (options) => {
				const lifecycle = this.options.lifecycle;
				const modelChoice = this.modelChoice;
				if (!lifecycle?.newSession || !modelChoice) return { cancelled: true };
				if (runner.hasHandlers("session_before_switch")) {
					const result = (await runner.emit({ type: "session_before_switch", reason: "new" } as never)) as
						| { cancel?: boolean }
						| undefined;
					if (result?.cancel) return { cancelled: true };
				}
				replacementId = await lifecycle.newSession(
					this.cwd,
					{
						provider: modelChoice.provider,
						modelId: modelChoice.modelId,
						...(modelChoice.thinkingLevel ? { thinkingLevel: modelChoice.thinkingLevel } : {}),
					},
					{
						...(options?.setup ? { setup: options.setup } : {}),
						...(options?.parentSession ? { parentSession: options.parentSession } : {}),
						...(options?.withSession ? { withSession: options.withSession } : {}),
					},
				);
				return { cancelled: false };
			},
			fork: async (entryId, options) => {
				const lifecycle = this.options.lifecycle;
				if (!lifecycle?.forkSession) return { cancelled: true };
				if (runner.hasHandlers("session_before_fork")) {
					const result = (await runner.emit({
						type: "session_before_fork",
						entryId,
						position: options?.position ?? "at",
					} as never)) as { cancel?: boolean } | undefined;
					if (result?.cancel) return { cancelled: true };
				}
				replacementId = await lifecycle.forkSession(entryId, options?.position, {
					...(options?.withSession ? { withSession: options.withSession } : {}),
				});
				return { cancelled: false };
			},
			switchSession: async (sessionPath, options) => {
				const lifecycle = this.options.lifecycle;
				if (!lifecycle?.switchSession) return { cancelled: true };
				if (runner.hasHandlers("session_before_switch")) {
					const result = (await runner.emit({
						type: "session_before_switch",
						reason: "resume",
						targetSessionFile: sessionPath,
					} as never)) as { cancel?: boolean } | undefined;
					if (result?.cancel) return { cancelled: true };
				}
				replacementId = await lifecycle.switchSession(sessionPath, {
					...(options?.withSession ? { withSession: options.withSession } : {}),
				});
				return { cancelled: false };
			},
		});
		return { getReplacementId: () => replacementId };
	}
}
