/** One ordinary Pi AgentSessionRuntime, with host-owned admission and observation. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Context, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type ImageContent } from "@earendil-works/pi-ai";
import {
	createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
	createEventBus, getAgentDir, hasTrustRequiringProjectResources, ModelRegistry, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionEvent, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory,
	type LoadExtensionsResult, type ModelRuntime, type ProjectTrustStore, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createAgentModelRuntime, inheritProviders } from "./model-runtime.ts";
import { ASSOCIATION_ENTRY, type AssociationSource } from "./associations.ts";
import { NestedStatus, OwnedSpend, type AgentFooterState } from "./footer.ts";
import type { AgentSessionMetadata, AgentStore, StoredAgentSession } from "./store.ts";

export const META_CUSTOM_TYPE = "agent.meta";
const RESULT_TYPE = "agent.result";
const START_TYPE = "agent.operation";
export interface WorkerModelChoice { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
export type ReplacedSessionContext = ReturnType<AgentSession["createReplacedSessionContext"]>;
export interface WorkerCreateOptions {
	cwd: string; agentDir?: string; trusted?: boolean; trustStore?: ProjectTrustStore;
	parentSessionPath?: string; model?: WorkerModelChoice; repairModel?: WorkerModelChoice;
	extensionPaths?: string[]; skillPaths?: string[]; name?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	onSessionCreated?: (sessionId: string) => void;
	onSessionClosed?: (sessionId: string) => void;
	onSessionReplaced?: (previousId: string, sessionId: string) => void;
	trustPrompt?: (cwd: string) => Promise<boolean | undefined>;
	store: AgentStore; modelRuntime: ModelRuntime; rootContext: Context;
	onUpdate?: (update: WorkerUpdate) => void;
}
export type WorkerUpdate =
	| { kind: "status" }
	| { kind: "replaced"; previousId: string; sessionId: string }
	| { kind: "entry"; entry: SessionEntry }
	| { kind: "error"; message: string }
	| { kind: "settled"; sessionId: string; result: WorkerResult };
export interface WorkerResult {
	operationId: string; status: "completed" | "failed" | "aborted";
	text?: string; error?: { message: string };
}
export interface WorkerStatus {
	sessionId: string; cwd: string; name?: string; tipId: string | null;
	model: { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
	operation: string | null; tools: string[]; activeTools: string[]; extensions: string[];
	entryCount: number; lastError?: string;
}
export interface WorkerCommandResult { text: string; sessionId?: string }
export interface WorkerObservation { currentTool?: string; lastText?: string; pending: number }
interface NativeAdmission {
	accepting: boolean;
	tasks: Set<Promise<unknown>>;
}
export class UnavailableAgentModelError extends Error {
	readonly sessionId: string;
	readonly cwd: string;
	readonly model: WorkerModelChoice;
	constructor(sessionId: string, cwd: string, model: WorkerModelChoice) {
		super(`Model ${model.provider}/${model.modelId} is unavailable for session ${sessionId}. Use agent_attach with an explicit available provider/model to repair an idle session.`);
		this.sessionId = sessionId; this.cwd = cwd; this.model = model;
	}
}
function selectedModel(session: AgentSession) {
	const model = session.model;
	if (!model) throw new Error("agent session has no selected model");
	return model;
}
function fragment(text: string, offset: number, maxBytes: number) {
	let bytes = 0;
	let end = offset;
	for (const character of text.slice(offset)) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		bytes += size; end += character.length;
	}
	return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null, truncated: end < text.length };
}

/** Owner-only inspection state. Omitted for a read-only snapshot of persisted entries. */
export interface InspectionOwner {
	operation: string | null;
	lastError: string | undefined;
}

/** Capture bounds attached to a read-only inspection. */
export interface InspectionCapture {
	available: boolean;
	bytes: number;
	unfinishedTail: boolean;
	reason?: string;
}

interface InspectionBase {
	sessionId: string;
	execution: { current: { id: string } | null; recovery: string };
	liveOwner: boolean;
	capture?: { mode: "read-only"; snapshot: true; available: boolean; bytes: number; unfinishedTail: boolean; liveState: "unavailable"; reason?: string };
	lastError?: { text: string; nextOffset: number | null; truncated: boolean };
}

function lastCustom(entries: SessionEntry[], customType: string): SessionEntry | undefined {
	return entries.findLast((entry) => entry.type === "custom" && entry.customType === customType);
}

function inspectionExecution(all: SessionEntry[], result: SessionEntry | undefined, owner?: InspectionOwner) {
	if (!owner) return { current: null, recovery: "read-only snapshot; live operation and owner result unavailable" };
	const lastStart = lastCustom(all, START_TYPE);
	const interrupted = !owner.operation && lastStart?.type === "custom" && (!result || all.indexOf(lastStart) > all.indexOf(result));
	return { current: owner.operation ? { id: owner.operation } : null, recovery: interrupted ? "interrupted; persisted history retained, no in-flight replay" : "ordinary persisted history; no in-flight replay" };
}

function inspectionCapture(capture: InspectionCapture) {
	return { mode: "read-only" as const, snapshot: true as const, available: capture.available, bytes: capture.bytes, unfinishedTail: capture.unfinishedTail, liveState: "unavailable" as const, ...(capture.reason ? { reason: capture.reason } : {}) };
}

function inspectionEntry(manager: SessionManager, sessionId: string, base: InspectionBase, entryId: string, offset?: number) {
	const entry = manager.getEntry(entryId);
	if (!entry) throw new Error(`no entry ${entryId} in session ${sessionId}`);
	const start = Math.max(0, offset ?? 0);
	return { ...base, entryId: entry.id, offset: start, ...fragment(JSON.stringify(entry), start, 12000) };
}

function inspectionPage(all: SessionEntry[], base: InspectionBase, result: SessionEntry | undefined, options: { cursor?: number; limit?: number }) {
	const end = Math.min(all.length, options.cursor ?? all.length);
	const start = Math.max(0, end - Math.max(1, Math.min(12, options.limit ?? 6)));
	const entries = all.slice(start, end).reverse().map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type, role: entry.type === "message" ? entry.message.role : undefined, ...fragment(JSON.stringify(entry), 0, 1200) }));
	return { ...base, result: result?.type === "custom" ? fragment(JSON.stringify(result.data), 0, 2400) : undefined, entries, nextCursor: start || null, order: "newestFirst" as const, detail: "Use entryId and offset for the complete serialized entry." };
}

/**
 * Project one session's persisted entries into a bounded inspection.
 *
 * Both the live owner and a read-only snapshot use this projection. When
 * `owner` is omitted, owner-only fields such as the current operation and last
 * error are reported unavailable instead of being guessed from stored history.
 */
export function projectInspection(
	manager: SessionManager,
	sessionId: string,
	options: { cursor?: number; limit?: number; entryId?: string; offset?: number },
	owner?: InspectionOwner,
	capture?: InspectionCapture,
) {
	const all = manager.getEntries();
	const result = lastCustom(all, RESULT_TYPE);
	const base: InspectionBase = {
		sessionId,
		execution: inspectionExecution(all, result, owner),
		liveOwner: owner !== undefined,
		...(capture ? { capture: inspectionCapture(capture) } : {}),
		...(owner?.lastError ? { lastError: fragment(owner.lastError, 0, 2400) } : {}),
	};
	return options.entryId ? inspectionEntry(manager, sessionId, base, options.entryId, options.offset) : inspectionPage(all, base, result, options);
}

export class AgentWorkerSession {
	private runtime!: AgentSessionRuntime;
	private held!: StoredAgentSession;
	private reserved: StoredAgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private closeTask: Promise<void> | undefined;
	private readonly tasks = new Set<Promise<unknown>>();
	private readonly observers = new Set<(event: AgentSessionEvent) => void>();
	private operation: string | undefined;
	private operationStart = 0;
	private operationAborted = false;
	private preflight = false;
	private nativePreflights = 0;
	private abortGeneration = 0;
	private readonly nativeAdmissions = new WeakMap<AgentSession, NativeAdmission>();
	private ownedRun = false;
	private stopping = false;
	private controlTask: Promise<unknown> | undefined;
	private startup: Promise<void> | undefined;
	private lastError: string | undefined;
	private terminal = false;
	private replacementFailed = false;
	private invalidated = false;
	private lastChoice: WorkerModelChoice | undefined;
	private readonly toolsRunning = new Map<string, string>();
	private lastText: string | undefined;
	private readonly options: WorkerCreateOptions;
	private readonly spend = new OwnedSpend();
	private readonly nested = new NestedStatus();
	private eventBus = createEventBus();
	footerState(): AgentFooterState {
		const active = !this.terminal && Boolean(this.operation || this.tasks.size || this.controlTask || this.preflight || this.nativePreflights || (this.runtime && (!this.runtime.session.isIdle || this.runtime.session.isBashRunning || this.runtime.session.pendingMessageCount)));
		return { active, spend: { ...this.spend.total }, nested: this.nested.snapshot() };
	}
	private publishFooter(): void { this.spend.sync(); this.notify({ kind: "status" }); }
	private constructor(options: WorkerCreateOptions) { this.options = options; }
	private get session(): AgentSession {
		if (this.terminal || this.replacementFailed || this.stopping) throw new Error("agent session host is closed");
		return this.runtime.session;
	}
	private get agentDir(): string { return this.options.agentDir ?? process.env.PI_AGENT_DIR ?? getAgentDir(); }
	sessionId(): string { return this.held.manager.getSessionId(); }
	sessionMetadata(): AgentSessionMetadata { return this.options.store.metadata(this.held.manager); }
	sessionManager(): SessionManager { return this.held.manager; }
	associationSource(): AssociationSource {
		const manager = this.held.manager;
		return { sessionId: manager.getSessionId(), entries: () => manager.getEntries(), append: (entry) => { manager.appendCustomEntry(ASSOCIATION_ENTRY, entry); } };
	}
	isProjectTrusted(): boolean { return this.runtime.services.settingsManager.isProjectTrusted(); }

	static async create(options: WorkerCreateOptions): Promise<AgentWorkerSession> {
		if (!options.model) throw new Error("agent session create requires an explicit model");
		const manager = SessionManager.create(options.cwd, options.store.nativeRoot, { parentSession: options.parentSessionPath });
		await options.setup?.(manager);
		return AgentWorkerSession.attach(options, options.store.adopt(manager));
	}
	static async open(metadata: AgentSessionMetadata, options: WorkerCreateOptions): Promise<AgentWorkerSession> {
		return AgentWorkerSession.attach(options, await options.store.open(metadata, options.rootContext));
	}
	static async fork(source: AgentSessionMetadata, options: WorkerCreateOptions & { entryId?: string; position?: "before" | "at" }): Promise<AgentWorkerSession> {
		return AgentWorkerSession.attach(options, await options.store.fork(source, options.rootContext, { ...options, requireModel: true }));
	}
	private static async attach(options: WorkerCreateOptions, held: StoredAgentSession): Promise<AgentWorkerSession> {
		const worker = new AgentWorkerSession(options);
		worker.held = held;
		try {
			worker.runtime = await createAgentSessionRuntime(worker.createRuntime, { cwd: held.manager.getCwd(), agentDir: worker.agentDir, sessionManager: held.manager });
			worker.runtime.setBeforeSessionInvalidate(() => { worker.invalidated = true; });
			worker.runtime.setRebindSession(async () => { await worker.bind(); worker.invalidated = false; });
			worker.startup = worker.bind();
			await worker.startup;
			if (worker.stopping) throw new Error("agent host closed during startup");
			if (options.name) await worker.setSessionName(options.name);
			return worker;
		} catch (error) {
			try { await worker.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "agent startup and cleanup failed"); }
			throw error;
		}
	}

	private async adoptReplacement(sessionManager: SessionManager): Promise<void> {
		// Native teardown emits shutdown and disposes synchronously before this
		// factory runs. The outgoing writer remains claimed until it is idle.
		if (this.runtime) await this.drainNative(this.runtime.session);
		const previous = this.held;
		if (previous.manager !== sessionManager) {
			this.held = this.reserved
				? this.options.store.rebind(this.reserved, sessionManager)
				: this.options.store.adopt(sessionManager);
			this.reserved = undefined;
			await previous.close();
			this.options.onSessionClosed?.(previous.metadata.id);
			this.options.onSessionReplaced?.(previous.metadata.id, this.sessionId());
			this.notify({ kind: "replaced", previousId: previous.metadata.id, sessionId: this.sessionId() });
			this.toolsRunning.clear(); this.lastText = undefined;
		}
		this.options.onSessionCreated?.(this.sessionId());
	}
	private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		await this.adoptReplacement(sessionManager);
		this.spend.bind(sessionManager);
		this.eventBus = createEventBus();
		this.nested.bind(this.eventBus, this.sessionId(), () => this.publishFooter());
		const stored = sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === META_CUSTOM_TYPE);
		const metadata = stored?.type === "custom" ? stored.data as { extensionPaths?: string[]; skillPaths?: string[] } | undefined : undefined;
		const settings = SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
		const modelRuntime = await createAgentModelRuntime({ authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json") });
		inheritProviders(modelRuntime, new ModelRegistry(this.options.modelRuntime), (this.lastChoice ?? this.options.model)?.provider);
		const services = await createAgentSessionServices({
			cwd, agentDir: this.agentDir, settingsManager: settings, modelRuntime,
			resourceLoaderOptions: { eventBus: this.eventBus, additionalExtensionPaths: this.options.extensionPaths ?? metadata?.extensionPaths ?? [], additionalSkillPaths: this.options.skillPaths ?? metadata?.skillPaths ?? [] },
			resourceLoaderReloadOptions: { resolveProjectTrust: async ({ extensionsResult }) => this.resolveTrust(cwd, extensionsResult, settings) },
		});
		const errors = [...services.diagnostics.filter((item) => item.type === "error").map((item) => item.message), ...services.resourceLoader.getExtensions().errors.map((item) => `${item.path}: ${item.error}`)];
		if (errors.length) throw new Error(errors.join("\n"));
		const saved = sessionManager.buildSessionContext();
		const choice = this.chooseModel(saved);
		const model = services.modelRuntime.getModel(choice.provider, choice.modelId);
		if (!model) throw new UnavailableAgentModelError(this.sessionId(), cwd, choice);
		if (this.options.repairModel && !services.modelRuntime.hasConfiguredAuth(choice.provider) && !(await services.modelRuntime.checkAuth(choice.provider))) throw new Error(`Authentication is not configured for ${choice.provider}; the stored model is unchanged`);
		const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: choice.thinkingLevel });
		// Preloaded messages suppress the SDK's initial model entry. Persist the
		// selected native model even when setup supplied conversation history.
		const selected = selectedModel(result.session);
		if (saved.model?.provider !== selected.provider || saved.model?.modelId !== selected.id) {
			sessionManager.appendModelChange(selected.provider, selected.id);
		}
		this.lastChoice = { provider: selected.provider, modelId: selected.id, thinkingLevel: result.session.thinkingLevel };
		const toolState = getCurrentSystemMessage(saved.messages);
		if (toolState) result.session.setActiveToolsByName((toolState.toolsAdded ?? []).map((tool) => tool.name));
		this.options.repairModel = undefined;
		if (!stored) sessionManager.appendCustomEntry(META_CUSTOM_TYPE, { extensionPaths: this.options.extensionPaths ?? [], skillPaths: this.options.skillPaths ?? [] });
		return { ...result, services, diagnostics: services.diagnostics };
	};

	private chooseModel(saved: ReturnType<SessionManager["buildSessionContext"]>): WorkerModelChoice {
		const choice = this.options.repairModel ?? (saved.model ? { ...saved.model, thinkingLevel: saved.thinkingLevel as ThinkingLevel } : this.lastChoice ?? this.options.model);
		if (!choice) throw new Error(`agent session ${this.sessionId()} has no stored model; select an explicit model`);
		return choice;
	}
	private async extensionTrust(cwd: string, extensions: LoadExtensionsResult): Promise<boolean | undefined> {
		for (const extension of extensions.extensions) {
			for (const handler of extension.handlers.get("project_trust") ?? []) {
				try {
					const result = await handler({ type: "project_trust", cwd }, { cwd, mode: "print", hasUI: false, ui: { notify() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined } } as never) as { trusted?: string; remember?: boolean } | undefined;
					if (result?.trusted !== "yes" && result?.trusted !== "no") continue;
					const trusted = result.trusted === "yes";
					if (result.remember) this.options.trustStore?.set(cwd, trusted);
					return trusted;
				} catch { /* A failed trust handler does not authorize project resources. */ }
			}
		}
		return undefined;
	}
	private async resolveTrust(cwd: string, extensions: LoadExtensionsResult, settings: SettingsManager): Promise<boolean> {
		if (this.options.trusted !== undefined && cwd === this.options.cwd) return this.options.trusted;
		if (!hasTrustRequiringProjectResources(cwd)) return true;
		const extensionDecision = await this.extensionTrust(cwd, extensions);
		if (extensionDecision !== undefined) return extensionDecision;
		const stored = this.options.trustStore?.get(cwd);
		if (stored != null) return stored;
		const decision = settings.getDefaultProjectTrust();
		if (decision === "always") return true;
		if (decision === "never") return false;
		const prompted = await this.options.trustPrompt?.(cwd);
		if (prompted !== undefined) this.options.trustStore?.set(cwd, prompted);
		return prompted ?? false;
	}

	private async bind(): Promise<void> {
		this.unsubscribe?.();
		const session = this.session;
		this.trackNativePrompts(session);
		this.unsubscribe = session.subscribe((event) => this.receive(event));
		// Runtime newSession applies setup after construction and before rebind.
		const saved = session.sessionManager.buildSessionContext();
		if (saved.model && (saved.model.provider !== session.model?.provider || saved.model.modelId !== session.model.id)) {
			const model = this.runtime.services.modelRuntime.getModel(saved.model.provider, saved.model.modelId);
			if (!model) throw new UnavailableAgentModelError(this.sessionId(), session.sessionManager.getCwd(), saved.model);
			await session.setModel(model);
		}
		session.setThinkingLevel(saved.thinkingLevel as ThinkingLevel);
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.replace(() => this.runtime.newSession(options)),
				fork: (entryId, options) => this.replace(() => this.runtime.fork(entryId, options)),
				switchSession: async (path, options) => {
					const metadata = (await this.options.store.list()).find((row) => row.path === path || row.id === path);
					if (!metadata) throw new Error("switch target is not a native agent session");
					if (this.reserved) throw new Error("session replacement is already in progress");
					this.reserved = await this.options.store.open(metadata);
					try { return await this.replace(() => this.runtime.switchSession(metadata.path, options)); }
					finally { await this.reserved?.close(); this.reserved = undefined; }
				},
				navigateTree: (target, options) => session.navigateTree(target, options),
				reload: () => session.reload(),
			},
			onError: (error) => this.reportError(`${error.event}: ${error.error}`),
			shutdownHandler: () => { void this.close().catch((error) => this.reportError(String(error))); },
		});
		this.nested.request(this.eventBus);
		this.publishFooter();
	}
	/** Native user sends enter prompt; custom sends have their own admission path. */
	private trackNativePrompts(session: AgentSession): void {
		if (this.nativeAdmissions.has(session)) return;
		const admission: NativeAdmission = { accepting: true, tasks: new Set() };
		this.nativeAdmissions.set(session, admission);
		const prompt = session.prompt.bind(session);
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		session.prompt = (text, options) => {
			if (!admission.accepting || this.stopping) return Promise.reject(new Error("agent session native input is closed"));
			// Pi dispatches registered commands before input preflight. A command
			// can await replacement, so it belongs to host work, not the old run.
			const commandName = text.slice(1, text.indexOf(" ") < 0 ? undefined : text.indexOf(" "));
			if (options?.expandPromptTemplates !== false && text.startsWith("/") && session.extensionRunner.getCommand(commandName)) return this.track(prompt(text, options));
			const generation = this.abortGeneration;
			let preflight = true;
			this.nativePreflights++;
			const finishPreflight = () => { if (preflight) { preflight = false; this.nativePreflights--; } };
			const task = prompt(text, { ...options, preflightResult: (success) => {
				finishPreflight();
				if (generation !== this.abortGeneration || this.stopping || !admission.accepting) throw new Error("agent prompt aborted during preflight");
				options?.preflightResult?.(success);
			} });
			return this.trackNative(admission, task.finally(finishPreflight));
		};
		session.sendCustomMessage = (message, options) => {
			if (!admission.accepting || this.stopping) return Promise.reject(new Error("agent session native input is closed"));
			return this.trackNative(admission, sendCustomMessage(message, options));
		};
	}
	private trackNative<T>(admission: NativeAdmission, task: Promise<T>): Promise<T> {
		admission.tasks.add(task);
		void task.finally(() => admission.tasks.delete(task)).catch(() => undefined);
		return this.track(task);
	}
	private fenceNative(session: AgentSession): void {
		const admission = this.nativeAdmissions.get(session);
		if (admission) admission.accepting = false;
	}
	private async drainNative(session: AgentSession): Promise<void> {
		this.fenceNative(session);
		await session.abort();
		const tasks = this.nativeAdmissions.get(session)?.tasks;
		while (tasks?.size) await Promise.allSettled(tasks);
		await session.waitForIdle();
		if (!session.isIdle) throw new Error("native session cleanup is incomplete; writer claim retained");
	}
	private async replace<T>(action: () => Promise<T>): Promise<T> {
		const outgoing = this.session;
		const model = selectedModel(outgoing);
		this.lastChoice = { provider: model.provider, modelId: model.id, thinkingLevel: outgoing.thinkingLevel };
		this.fenceNative(outgoing);
		try { return await action(); }
		catch (error) {
			// Native replacement has no rollback after teardown or failed rebind.
			this.replacementFailed = this.invalidated;
			if (this.replacementFailed) {
				try { await this.disposeHost(); } catch (cleanup) { throw new AggregateError([error, cleanup], "replacement and cleanup failed"); }
			}
			throw error;
		} finally {
			// A cancelled transition or a validation failure leaves the native
			// session intact. Only that same, still-valid session accepts input.
			if (!this.invalidated && !this.stopping && !this.replacementFailed && this.runtime.session === outgoing) {
				const admission = this.nativeAdmissions.get(outgoing);
				if (admission) admission.accepting = true;
			}
		}
	}
	private notify(update: WorkerUpdate): void {
		try { this.options.onUpdate?.(update); }
		catch (error) { this.lastError = `Host notification failed: ${String(error)}`; }
	}
	private reportError(message: string): void {
		this.lastError = message;
		this.notify({ kind: "error", message });
	}
	private begin(): string {
		const id = randomUUID();
		this.operation = id; this.lastError = undefined; this.operationAborted = false; this.lastText = undefined;
		this.operationStart = this.sessionManager().getEntries().length;
		this.sessionManager().appendCustomEntry(START_TYPE, { operationId: id });
		this.publishFooter();
		return id;
	}
	private finish(): void {
		if (!this.operation) return;
		const operationId = this.operation;
		const assistant = this.sessionManager().getEntries().slice(this.operationStart).findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const message = assistant?.type === "message" && assistant.message.role === "assistant" ? assistant.message : undefined;
		const error = this.lastError ?? (message?.stopReason === "error" ? message.errorMessage ?? "model request failed" : undefined);
		const text = message?.content.map((part) => part.type === "text" ? part.text : "").join("");
		const result: WorkerResult = { operationId, status: this.operationAborted || message?.stopReason === "aborted" ? "aborted" : error ? "failed" : "completed", ...(text ? { text } : {}), ...(error ? { error: { message: error } } : {}) };
		this.sessionManager().appendCustomEntry(RESULT_TYPE, result);
		this.operation = undefined;
		this.notify({ kind: "settled", sessionId: this.sessionId(), result });
	}
	private receive(event: AgentSessionEvent): void {
		if (event.type === "agent_start" && !this.operation) this.begin();
		if (event.type === "tool_execution_start") this.toolsRunning.set(event.toolCallId, event.toolName);
		if (event.type === "tool_execution_end") this.toolsRunning.delete(event.toolCallId);
		if (event.type === "message_update" && event.message.role === "assistant") this.lastText = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		if (event.type === "entry_appended") this.notify({ kind: "entry", entry: event.entry });
		if (event.type === "agent_settled" && !this.ownedRun) this.finish();
		if (event.type !== "message_update") this.publishFooter();
		for (const observer of this.observers) {
			try { observer(event); } catch (error) { this.lastError = `Host observer failed: ${String(error)}`; }
		}
	}
	private track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		void task.finally(() => { this.tasks.delete(task); this.publishFooter(); }).catch(() => undefined);
		this.publishFooter();
		return task;
	}
	async start(prompt: string, images?: ImageContent[]): Promise<string | undefined> {
		const command = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(prompt);
		if (command && this.session.extensionRunner.getCommand(command[1])) { await this.runCommand(command[1], command[2] ?? ""); return undefined; }
		if (prompt.startsWith("!")) {
			await this.control(() => this.session.executeBash(prompt.slice(prompt.startsWith("!!") ? 2 : 1), undefined, { excludeFromContext: prompt.startsWith("!!") }));
			return undefined;
		}
		if (this.operation || this.hasPendingHostWork()) throw new Error("agent session has active work; use steer");
		const id = this.begin();
		this.preflight = true; this.ownedRun = true;
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
		const admitted = { promise, resolve, reject };
		const task = this.session.prompt(prompt, { images, preflightResult: (success) => {
			if (this.operationAborted || this.stopping) throw new Error("agent prompt aborted during preflight");
			if (success) { this.preflight = false; admitted.resolve(); }
		} });
		this.track(task.then(() => { admitted.resolve(); this.finish(); }, (error) => {
			this.reportError(error instanceof Error ? error.message : String(error)); this.finish(); admitted.reject(error);
		}).finally(() => { this.preflight = false; this.ownedRun = false; }));
		await admitted.promise;
		return id;
	}
	async deliverCustomMessage(message: Parameters<AgentSession["sendCustomMessage"]>[0], options?: Parameters<AgentSession["sendCustomMessage"]>[1]): Promise<void> {
		const session = this.session;
		if (this.preflight || this.nativePreflights || this.controlTask) throw new Error("agent session input preflight or control is in progress; retry after admission");
		if (!options?.triggerTurn || session.isStreaming) {
			await session.sendCustomMessage(message, options);
			return;
		}
		if (this.hasPendingHostWork() || this.operation) throw new Error("agent session is settling; retry after completion");
		this.begin(); this.ownedRun = true;
		let admissionError: unknown;
		const task = session.sendCustomMessage(message, options);
		this.track(task.then(() => this.finish(), (error) => {
			admissionError = error; this.reportError(String(error)); this.finish();
		}).finally(() => { this.ownedRun = false; }));
		// Native custom input starts synchronously or rejects its admission. Its
		// returned promise otherwise belongs to completion, not the receipt.
		await Promise.resolve();
		if (admissionError) throw admissionError;
	}
	async sendUserMessage(...args: Parameters<AgentSession["sendUserMessage"]>): Promise<void> { await this.track(this.session.sendUserMessage(...args)); }
	async steer(text: string, images?: ImageContent[]): Promise<void> { await this.session.steer(text, images); }
	async abort(): Promise<boolean> {
		const active = this.hasPendingHostWork();
		this.operationAborted = active; this.abortGeneration++;
		await this.session.abort();
		while (this.tasks.size) await Promise.allSettled(this.tasks);
		return active;
	}
	private control<T>(action: () => Promise<T>): Promise<T> {
		void this.session;
		if (this.controlTask || this.preflight || this.nativePreflights) return Promise.reject(new Error("agent session control or input preflight is in progress"));
		const task = Promise.resolve().then(action);
		this.controlTask = task;
		return this.track(task.finally(() => { if (this.controlTask === task) this.controlTask = undefined; }));
	}
	async compact(instructions?: string) { return this.control(() => this.session.compact(instructions)); }
	async reload(): Promise<void> { await this.control(() => this.session.reload()); this.nested.request(this.eventBus); }
	async appendCustomEntry(type: string, data: unknown): Promise<void> { this.sessionManager().appendCustomEntry(type, data); }
	async setSessionName(name: string | undefined): Promise<void> { this.session.setSessionName(name ?? ""); }
	async setModelAction(provider: string, modelId: string): Promise<boolean> {
		const runtime = this.runtime.services.modelRuntime;
		const model = runtime.getModel(provider, modelId);
		if (!model) throw new Error(`model ${provider}/${modelId} is not available`);
		if (!runtime.hasConfiguredAuth(provider) && !(await runtime.checkAuth(provider))) return false;
		await this.session.setModel(model); return true;
	}
	async setThinkingLevelAction(level: ThinkingLevel): Promise<ThinkingLevel> { this.session.setThinkingLevel(level); return this.session.thinkingLevel; }
	async setActiveToolsAction(names: string[]): Promise<void> { this.session.setActiveToolsByName(names); }
	createReplacedSessionContext(): ReplacedSessionContext { return this.session.createReplacedSessionContext(); }
	async runCommand(name: string, args: string): Promise<WorkerCommandResult> {
		return this.control(() => this.executeCommand(name, args));
	}
	private async executeCommand(name: string, args: string): Promise<WorkerCommandResult> {
		const previous = this.sessionId();
		if (name === "reload") await this.session.reload();
		else if (name === "tree") {
			if (!args.trim()) return { text: this.sessionManager().getEntries().slice(-100).map((entry) => `${entry.id} parent=${entry.parentId ?? "root"} ${entry.type}`).join("\n") };
			await this.session.navigateTree(args.trim());
		} else {
			const command = this.session.extensionRunner.getCommand(name);
			if (!command) throw new Error(`unknown command "${name}" in agent session ${previous}`);
			await command.handler(args, this.session.extensionRunner.createCommandContext());
		}
		return { text: "Command completed.", ...(previous !== this.sessionId() ? { sessionId: this.sessionId() } : {}) };
	}
	setOnUpdate(onUpdate?: (update: WorkerUpdate) => void): void { this.options.onUpdate = onUpdate; }
	observe(listener: (event: AgentSessionEvent) => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
	observation(): WorkerObservation { return { currentTool: this.toolsRunning.values().next().value, lastText: this.lastText, pending: this.session.pendingMessageCount }; }
	hasPendingHostWork(): boolean { return !this.session.isIdle || this.session.isBashRunning || this.tasks.size > 0 || this.session.pendingMessageCount > 0; }
	lastErrorMessage(): string | undefined { return this.lastError; }
	async operationResult(id: string): Promise<WorkerResult | undefined> {
		const entry = this.sessionManager().getEntries().findLast((entry) => entry.type === "custom" && entry.customType === RESULT_TYPE && (entry.data as WorkerResult)?.operationId === id);
		return entry?.type === "custom" ? entry.data as WorkerResult : undefined;
	}
	async status(): Promise<WorkerStatus> {
		const session = this.session;
		const model = selectedModel(session);
		return { sessionId: this.sessionId(), cwd: session.sessionManager.getCwd(), name: session.sessionManager.getSessionName(), tipId: session.sessionManager.getLeafId(), model: { provider: model.provider, modelId: model.id, thinkingLevel: session.thinkingLevel }, operation: this.operation ?? null, tools: session.getAllTools().map((tool) => tool.name), activeTools: session.getActiveToolNames(), extensions: session.resourceLoader.getExtensions().extensions.map((extension) => extension.path), entryCount: session.sessionManager.getEntries().length, ...(this.lastError ? { lastError: this.lastError.slice(0, 2000) } : {}) };
	}
	async inspect(options: { cursor?: number; limit?: number; entryId?: string; offset?: number } = {}) {
		return projectInspection(this.sessionManager(), this.sessionId(), options, { operation: this.operation ?? null, lastError: this.lastError });
	}
	async waitForIdle(): Promise<void> {
		while (this.tasks.size) await Promise.allSettled(this.tasks);
		await this.session.waitForIdle();
	}
	private async disposeHost(): Promise<void> {
		const errors: unknown[] = [];
		const attempt = async (action: () => unknown) => { try { await action(); } catch (error) { errors.push(error); } };
		let cleanupComplete = !this.runtime;
		if (this.runtime) {
			const session = this.runtime.session;
			this.fenceNative(session);
			if (!this.invalidated) await attempt(() => this.runtime.dispose());
			// Shutdown handlers run before native disposal. Even after disposal,
			// provider cleanup and admitted preflight promises still need a join.
			let disposed = false;
			await attempt(() => { session.dispose(); this.invalidated = true; disposed = true; });
			await attempt(async () => { await this.drainNative(session); cleanupComplete = disposed; });
		}
		this.spend.sync();
		this.unsubscribe?.(); this.observers.clear(); this.nested.close();
		if (!cleanupComplete) throw new AggregateError(errors, "agent host cleanup incomplete; writer claims retained");
		await attempt(() => this.reserved?.close());
		await attempt(() => this.held?.close());
		this.terminal = true;
		this.publishFooter();
		await attempt(() => this.options.onSessionClosed?.(this.sessionId()));
		if (errors.length) throw new AggregateError(errors, "agent host cleanup failed");
	}
	close(_reason = "quit"): Promise<void> {
		this.closeTask ??= (async () => {
			this.stopping = true; this.operationAborted = true; this.abortGeneration++;
			await this.startup?.catch(() => undefined);
			if (this.runtime && !this.terminal) {
				this.fenceNative(this.runtime.session);
				await this.runtime.session.abort();
				while (this.tasks.size) await Promise.allSettled(this.tasks);
			}
			if (!this.terminal) await this.disposeHost();
		})().catch((error) => { this.closeTask = undefined; throw error; });
		return this.closeTask;
	}
}
