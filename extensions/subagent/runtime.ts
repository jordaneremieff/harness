/**
 * Worker runtime: the parent-side control object for one worker session.
 *
 * The worker is a real pi AgentSession that runs inside the dispatching
 * session. This file adapts released AgentSession state and events into a
 * stable local surface — phase, snapshot transcript, prompt/steer/abort/model
 * control — that the extension's control paths and the inspection/console
 * renderers consume. There is no wire protocol and no remote client: the
 * transcript items declared here are the extension's own contract, produced by
 * exactly one conversion and consumed by exactly the renderers in this slice.
 *
 * Three things AgentSession does not hand over cleanly, and how this handles them:
 *
 * - Messages have no id. Ids are synthesized into a WeakMap keyed on the final
 *   message object. Streaming updates arrive as spread copies, so identity is not
 *   stable mid-stream; deltas are tracked by content index against a per-stream
 *   emitted-length map instead.
 * - The in-flight message is not in `state.messages` until it ends; it lives in
 *   `state.streamingMessage` and is appended to snapshots explicitly.
 * - AgentSession exposes only `isStreaming`, and that stays true through post-run
 *   compaction. Phase is therefore tracked from session events, which take
 *   priority over `isStreaming`; without this an observer could treat a
 *   compacting worker as idle.
 *
 * Re-run these checks after a Pi upgrade:
 *
 * | Access                              | Used by           | Upgrade check |
 * |-------------------------------------|-------------------|---------------|
 * | `session.state.messages`            | buildTranscript() | A tool run snapshot keeps user, assistant, and tool items in order. |
 * | `session.state.streamingMessage`    | snapshot()        | A mid-run snapshot includes the in-flight assistant item. |
 * | `session.state.model`               | setModel()        | The snapshot model changes without a settings write. |
 * | `session.state.thinkingLevel`       | setThinking()     | The thinking level changes without a settings write. |
 * | `session.modelRuntime.getModel()`   | setModel()        | A known model resolves; an unknown model returns `invalid_request`. |
 * | `session.isStreaming` and events    | getPhase()        | Turn, compaction, retry, branch-summary, and idle phases stay distinct. |
 */

import type { Usage as AiUsage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Local surface types (the extension's own contract)
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SessionPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export type TranscriptJsonValue =
	| null
	| boolean
	| number
	| string
	| TranscriptJsonValue[]
	| { [key: string]: TranscriptJsonValue };

export interface TranscriptTextPart {
	type: "text";
	text: string;
}
export interface TranscriptImagePart {
	type: "image";
	mimeType: string;
}
export interface TranscriptThinkingPart {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface TranscriptToolCallPart {
	type: "toolCall";
	toolCallId: string;
	toolName: string;
	input: TranscriptJsonValue;
}

export type TranscriptContentPart = TranscriptTextPart | TranscriptImagePart;
export type TranscriptAssistantContentPart = TranscriptTextPart | TranscriptThinkingPart | TranscriptToolCallPart;

export interface TranscriptUserItem {
	role: "user";
	id: string;
	content: TranscriptContentPart[];
	timestamp: number;
}
export interface TranscriptAssistantItem {
	role: "assistant";
	id: string;
	content: TranscriptAssistantContentPart[];
	status: "streaming" | "completed";
	model: { provider: string; id: string };
	stopReason?: string;
	errorMessage?: string;
	timestamp: number;
}
export interface TranscriptToolItem {
	role: "tool";
	id: string;
	toolCallId: string;
	toolName: string;
	input: TranscriptJsonValue;
	content: TranscriptContentPart[];
	status: "running" | "complete" | "error";
	isError: boolean;
	details?: unknown;
	usage?: AiUsage;
	timestamp: number;
}

export type TranscriptItem = TranscriptUserItem | TranscriptAssistantItem | TranscriptToolItem;

export interface SessionSnapshot {
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	phase: SessionPhase;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	attached: boolean;
	locked: boolean;
	revision: number;
	transcript: TranscriptItem[];
	queuedSteer: TranscriptUserItem[];
	queuedSteerCount: number;
}

export interface PromptInput {
	text: string;
}

export interface SteerInput {
	text: string;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export type WorkerProgress =
	| { type: "item_started"; item: TranscriptItem }
	| { type: "item_updated"; item: Extract<TranscriptItem, { status: "running" }> }
	| { type: "item_finished"; item: TranscriptItem }
	| { type: "assistant_delta"; messageId: string; contentIndex: number; kind: "text" | "thinking"; delta: string };

export type WorkerRuntimeEvent = { type: "snapshot" } | { type: "progress"; progress: WorkerProgress };

/** Error from a worker-control operation, carrying a machine-readable code. */
export class WorkerRuntimeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkerRuntimeError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Message shape and conversion
// ---------------------------------------------------------------------------

type SessionMessage = AgentSession["state"]["messages"][number];
type AssistantSessionMessage = Extract<SessionMessage, { role: "assistant" }>;

interface ToolItemInput {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	content?: TranscriptContentPart[];
	status: "running" | "complete" | "error";
	details?: unknown;
	usage?: AiUsage;
	timestamp: number;
}

/** A JSON-compatible deep copy; values with no JSON form become null. */
function transcriptJsonValue(value: unknown): TranscriptJsonValue {
	if (value === null) return null;
	if (value === undefined) return null;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(transcriptJsonValue);
	if (typeof value === "object") {
		const out: { [key: string]: TranscriptJsonValue } = {};
		for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
			out[key] = transcriptJsonValue(member);
		}
		return out;
	}
	return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function transcriptUserContent(content: unknown): TranscriptContentPart[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) throw new Error("user message content is not text or parts");
	const parts: TranscriptContentPart[] = [];
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "image" && typeof part.mimeType === "string") {
			parts.push({ type: "image", mimeType: part.mimeType });
		}
	}
	return parts;
}

function transcriptToolContent(content: unknown): TranscriptContentPart[] {
	return transcriptUserContent(content);
}

/** One assistant content part. An unaddressable tool call (no id or name) throws
 * so the caller can prune and retry a mid-stream partial. */
function assistantContentPart(part: unknown): TranscriptAssistantContentPart {
	if (!isObject(part)) throw new Error("assistant content part is not an object");
	switch (part.type) {
		case "text":
			if (typeof part.text !== "string") throw new Error("assistant text part has no text");
			return { type: "text", text: part.text };
		case "thinking": {
			if (typeof part.thinking !== "string") throw new Error("assistant thinking part has no thinking");
			return part.redacted === true
				? { type: "thinking", thinking: part.thinking, redacted: true }
				: { type: "thinking", thinking: part.thinking };
		}
		case "toolCall": {
			if (typeof part.id !== "string" || part.id === "") throw new Error("tool call has no id");
			if (typeof part.name !== "string" || part.name === "") throw new Error("tool call has no name");
			return {
				type: "toolCall",
				toolCallId: part.id,
				toolName: part.name,
				input: transcriptJsonValue((part as { arguments?: unknown }).arguments ?? {}),
			};
		}
		default:
			throw new Error("assistant content part has no transcript form");
	}
}

/** Assistant messages with a mappable stop reason become transcript items;
 * pending stays streaming. Messages the conversation cannot represent — missing,
 * unknown, or deferred stop reasons, or an error with no message — return null
 * so the caller drops them, exactly as a settled transcript does. */
function assistantTranscriptItem(message: unknown, id: string): TranscriptAssistantItem | null {
	if (!isObject(message)) return null;
	if (message.role !== "assistant") return null;
	if (!Array.isArray(message.content)) return null;
	const stopReason = message.stopReason;
	if (stopReason === "deferred") return null;
	if (typeof stopReason !== "string") return null;
	if (!["pending", "stop", "length", "toolUse", "error", "aborted"].includes(stopReason)) return null;
	if (stopReason === "error" && !message.errorMessage) return null;
	const content: TranscriptAssistantContentPart[] = [];
	for (const part of message.content) {
		content.push(assistantContentPart(part));
	}
	const model = {
		provider: typeof message.provider === "string" ? message.provider : "unknown",
		id: typeof message.model === "string" ? message.model : "unknown",
	};
	const item: TranscriptAssistantItem = {
		role: "assistant",
		id,
		content,
		status: stopReason === "pending" ? "streaming" : "completed",
		model,
		timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
	};
	if (stopReason === "error" || stopReason === "aborted") {
		if (typeof message.errorMessage === "string" && message.errorMessage) item.errorMessage = message.errorMessage;
		else if (stopReason === "error") return null;
	}
	if (typeof stopReason === "string") item.stopReason = stopReason;
	return item;
}

function toolResultTranscriptItem(
	message: {
		toolCallId: string;
		toolName: string;
		content: unknown;
		details?: unknown;
		usage?: AiUsage;
		isError: boolean;
		timestamp: number;
	},
	options: { id: string; arguments?: unknown },
): TranscriptToolItem {
	const base: TranscriptToolItem = {
		role: "tool",
		id: options.id,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		input: transcriptJsonValue(options.arguments ?? {}),
		content: transcriptToolContent(message.content),
		status: message.isError ? "error" : "complete",
		isError: message.isError,
		timestamp: message.timestamp,
	};
	if (message.details !== undefined) base.details = message.details;
	if (message.usage !== undefined) base.usage = message.usage;
	return base;
}

function userTranscriptItem(message: unknown, id: string): TranscriptUserItem {
	if (!isObject(message)) throw new Error("user message is not an object");
	return {
		role: "user",
		id,
		content: transcriptUserContent(message.content),
		timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
	};
}

/**
 * Convert pi messages to the local transcript items. The one conversion used
 * by BOTH transcript paths — a live worker's in-memory state and a terminal
 * worker's session file — so there is exactly one reader of pi's message shape.
 *
 * Roles with no transcript representation are dropped: `custom`,
 * `bashExecution`, `branchSummary`, and `compactionSummary`, as are assistant
 * messages whose stop reason is missing, unknown, `deferred`, or an `error`
 * with no message. A `toolResult` with no matching call is dropped because the
 * console renders tool output inside the call's box, so an orphan result was
 * never visible.
 */
export function buildTranscript(
	messages: SessionMessage[],
	idFor: (message: SessionMessage) => string,
): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const toolCalls = new Map<string, unknown>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (isObject(part) && part.type === "toolCall") {
				toolCalls.set(part.id as string, part);
			}
		}
	}
	for (const message of messages) {
		if (message.role === "user") {
			try {
				items.push(userTranscriptItem(message, idFor(message)));
			} catch {
				// A malformed message is skipped, never fatal to a transcript view.
			}
		} else if (message.role === "assistant") {
			try {
				const item = assistantTranscriptItem(message, idFor(message));
				if (item) items.push(item);
			} catch {
				// A part with no transcript form skips the whole message.
			}
		} else if (message.role === "toolResult") {
			const call = toolCalls.get(message.toolCallId);
			if (!call) continue;
			try {
				const messageShape = {
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: message.content,
					details: (message as { details?: unknown }).details,
					usage: (message as { usage?: AiUsage }).usage,
					isError: message.isError,
					timestamp: message.timestamp,
				};
				items.push(
					toolResultTranscriptItem(messageShape, {
						id: idFor(message),
						arguments: (call as { arguments?: unknown }).arguments,
					}),
				);
			} catch {
				// Same containment.
			}
		}
	}
	return items;
}

/**
 * Transcript items for a worker this session no longer owns, read from its
 * recorded session file. Same conversion as a live snapshot; ids are positional
 * because the messages are dead objects with no runtime identity.
 */
export function transcriptFromMessages(messages: SessionMessage[]): TranscriptItem[] {
	const ids = new Map<SessionMessage, string>();
	let seq = 0;
	return buildTranscript(messages, (message) => {
		let id = ids.get(message);
		if (!id) {
			id = `m-${++seq}`;
			ids.set(message, id);
		}
		return id;
	});
}

interface StreamState {
	id: string;
	lens: Map<number, number>;
}

const pendingCommandTurns = new WeakMap<AgentSession, Set<Promise<void>>>();

function holdCommandTurn(session: AgentSession, promise: Promise<void>): Promise<void> {
	const pending = pendingCommandTurns.get(session);
	if (!pending) return promise;
	pending.add(promise);
	void promise.then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	);
	return promise;
}

/**
 * Install before extension binding. Pi binds ExtensionAPI message methods as
 * dynamic calls through the AgentSession instance and does not await them.
 * Keeping the original promise lets the worker own a turn that an extension
 * starts while preserving Pi's return value and rejection behavior.
 */
export function trackCommandStartedTurns(session: AgentSession): void {
	if (pendingCommandTurns.has(session)) return;
	pendingCommandTurns.set(session, new Set());
	const sendUserMessage = session.sendUserMessage;
	const sendCustomMessage = session.sendCustomMessage;
	session.sendUserMessage = ((...args: Parameters<AgentSession["sendUserMessage"]>) =>
		holdCommandTurn(session, sendUserMessage.apply(session, args))) as AgentSession["sendUserMessage"];
	session.sendCustomMessage = ((...args: Parameters<AgentSession["sendCustomMessage"]>) =>
		holdCommandTurn(session, sendCustomMessage.apply(session, args))) as AgentSession["sendCustomMessage"];
}

export interface WorkerRuntimeOptions {
	session: AgentSession;
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
	onSessionStateChange?: (session: AgentSession) => void;
}

/** Adapts one worker AgentSession to the extension's control surface. */
export class WorkerRuntime {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;

	private session: AgentSession;
	private _cwd: string;
	private revision = 0;
	private readonly listeners = new Set<(event: WorkerRuntimeEvent) => void>();
	/** In-process observers; survive dispose(), unlike `listeners`. */
	private readonly watchers = new Set<() => void>();
	private msgSeq = 0;
	private readonly msgIds = new WeakMap<object, string>();
	private readonly steerIds = new Map<string, string>();
	private stream: StreamState | null = null;
	/** Live tool state. The end event omits arguments, so one keyed owner retains
	 * the validated start arguments and any partial output. */
	private readonly liveTools = new Map<
		string,
		{ toolName: string; args: unknown; content?: TranscriptContentPart[] }
	>();
	private phase: SessionPhase = "idle";
	private compactionCount = 0;
	private retryActive = false;
	private branchSummaryActive = false;
	/** True while this control object owns one prompt call across replacements. */
	private promptActive = false;
	/**
	 * Set by abort() and cleared by prompt(). AgentSession.prompt awaits an async
	 * preflight (auth refresh, compaction, busy checks) before a cancellable run
	 * exists, and Agent.abort() is a no-op while no run is active — so an abort
	 * arriving in that window is silently lost and the run starts anyway. This
	 * flag carries the intent forward to `agent_start`, which re-issues it.
	 */
	private abortRequested = false;
	private unsubscribe: (() => void) | null = null;
	private readonly onSessionStateChange: ((session: AgentSession) => void) | undefined;

	constructor(options: WorkerRuntimeOptions) {
		this.session = options.session;
		this._cwd = options.cwd;
		this.id = options.id;
		this.name = options.name;
		this.createdAt = options.createdAt;
		this.onSessionStateChange = options.onSessionStateChange;
		this.subscribeToSession();
	}

	get cwd(): string {
		return this._cwd;
	}

	/** Follow AgentSessionRuntime when a command replaces the active session. */
	replaceSession(session: AgentSession): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.session = session;
		this._cwd = session.sessionManager.getCwd();
		this.stream = null;
		this.liveTools.clear();
		this.steerIds.clear();
		this.compactionCount = 0;
		this.retryActive = false;
		this.branchSummaryActive = false;
		this.phase = this.promptActive ? "turn" : "idle";
		this.subscribeToSession();
		this.recomputePhase();
		this.emit({ type: "snapshot" });
	}

	private subscribeToSession(): void {
		this.unsubscribe = this.session.subscribe((event) => {
			try {
				this.onSessionEvent(event);
			} catch {
				// AgentSession invokes listeners without containment. A malformed
				// message or conversion must not escape into the worker run.
			}
		});
	}

	// ------------------------------------------------------------ control surface

	/** Released AgentSession state used for transcript snapshots. */
	private agentState(): AgentSession["state"] {
		return this.session.state;
	}

	snapshot(): SessionSnapshot {
		const state = this.agentState();
		const items = buildTranscript(state.messages, (message) => this.messageId(message));
		const streaming = state.streamingMessage;
		if (streaming?.role === "assistant") {
			const id = this.stream?.id ?? this.messageId(streaming);
			let item: TranscriptAssistantItem | null = null;
			try {
				item = assistantTranscriptItem(streaming, id);
				if (!item) item = assistantTranscriptItem({ ...streaming, stopReason: "pending" }, id);
			} catch {
				// A provider stream can emit a partial toolCall before its id and name.
				// Drop only the un-addressable toolCall parts and retry so the rest
				// still renders.
				const content = streaming.content;
				const pruned = content.filter((part) =>
					isObject(part) && part.type === "toolCall" ? Boolean(part.id && part.name) : true,
				);
				if (pruned.length !== content.length) {
					try {
						const fallback = { ...streaming, content: pruned };
						item = assistantTranscriptItem(fallback, id);
						if (!item) item = assistantTranscriptItem({ ...fallback, stopReason: "pending" }, id);
					} catch {
						// Still unmappable; skip the in-flight item for this snapshot.
					}
				}
			}
			if (item) items.push(item);
		}
		// Synthetic running items carry live partial output to the panel; the real
		// toolResult replaces them at tool_execution_end.
		for (const [toolCallId, partial] of this.liveTools) {
			const hasToolResult = items.some((item) => item.role === "tool" && item.toolCallId === toolCallId);
			if (hasToolResult) continue;
			items.push(
				this.toolItem({
					toolCallId,
					toolName: partial.toolName,
					args: partial.args,
					content: partial.content,
					status: "running",
					timestamp: Date.now(),
				}),
			);
		}
		const steerTexts = this.session.getSteeringMessages();
		const queuedSteer: TranscriptUserItem[] = steerTexts.map((text, index) => ({
			id: this.steerId(text),
			role: "user",
			content: [{ type: "text", text }],
			timestamp: this.createdAt + index,
		}));
		const model = this.session.model;
		return {
			id: this.id,
			name: this.name,
			cwd: this.cwd,
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			phase: this.getPhase(),
			model: model ? { provider: model.provider, id: model.id } : { provider: "unknown", id: "unknown" },
			thinkingLevel: this.session.thinkingLevel ?? "off",
			attached: false,
			locked: true,
			revision: this.revision,
			transcript: items,
			queuedSteer,
			queuedSteerCount: queuedSteer.length,
		};
	}

	private currentPhase(fallback: SessionPhase): SessionPhase {
		if (this.compactionCount > 0) return "compaction";
		if (this.retryActive) return "retry";
		if (this.branchSummaryActive) return "branch_summary";
		if (this.session.isStreaming || this.promptActive) return "turn";
		return fallback;
	}

	getPhase(): SessionPhase {
		return this.currentPhase(this.phase);
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.getPhase() !== "idle") {
			throw new WorkerRuntimeError("busy", "the worker is already running a turn");
		}
		// Optimistic: AgentSession preflight is async; events confirm the phase.
		this.abortRequested = false;
		this.promptActive = true;
		this.phase = "turn";
		try {
			// A worker is a full session: pi's prompt defaults apply, so extension
			// commands, skill commands, and prompt templates expand exactly as they
			// do for any session input. No expansion suppression of its own.
			await this.session.prompt(input.text);
			// Extension commands can start turns through fire-and-forget ExtensionAPI
			// messages. Drain both starts and active runs until no replacement session
			// has more work that belongs to this prompt.
			for (;;) {
				const active = this.session;
				const pending = pendingCommandTurns.get(active);
				if (pending && pending.size > 0) {
					await Promise.allSettled([...pending]);
					continue;
				}
				if (active.isStreaming) {
					await active.waitForIdle();
					continue;
				}
				if (active === this.session && !(pendingCommandTurns.get(active)?.size ?? 0)) break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/already processing|compaction/.test(message)) {
				throw new WorkerRuntimeError("busy", message);
			}
			throw error;
		} finally {
			this.abortRequested = false;
			this.promptActive = false;
			this.recomputePhase();
			this.emit({ type: "snapshot" });
		}
	}

	async steer(input: SteerInput): Promise<void> {
		// AgentSession queues steers unconditionally: mid-run they are drained after
		// the current tool batch, before the next model call; when queued during
		// preflight or while idle, they are delivered at the start of the next run,
		// before its first model call. That is the accepted behavior here, and it
		// deviates from a reject-when-idle control contract on purpose.
		await this.session.steer(input.text);
		this.emit({ type: "snapshot" });
	}

	async abort(): Promise<void> {
		this.session.clearQueue();
		if (this.getPhase() === "idle") return;
		// Recorded before the call: if this lands during prompt preflight there is
		// no run to abort yet, and session.abort() returns having done nothing.
		// `agent_start` re-issues it once a real run exists.
		this.abortRequested = true;
		// During preflight isStreaming is false and session.abort() is a no-op. Only
		// reconcile the phase when the abort actually stopped a run; otherwise
		// recomputePhase() would drop phase to "idle" while a run is still coming,
		// unlocking prompt()'s busy guard and letting a second prompt erase this
		// pending abort intent (the ghost run the flag exists to prevent).
		const hadRun = this.session.isStreaming;
		await this.session.abort();
		if (hadRun) this.recomputePhase();
	}

	async setModel(ref: ModelRef): Promise<void> {
		const model = this.session.modelRuntime.getModel(ref.provider, ref.id);
		if (!model) {
			throw new WorkerRuntimeError("invalid_request", `unknown model ${ref.provider}/${ref.id}`);
		}
		// Direct state assignment on purpose: AgentSession.setModel() would persist a
		// new default into the operator's settings.json. A worker's model must never
		// mutate the operator's defaults.
		const state = this.session.state;
		state.model = model;
		// Re-clamp the level against the NEW model by hand. AgentSession.setThinkingLevel
		// writes the clamped level into the operator's global defaultThinkingLevel,
		// which is the same persistence this method exists to avoid.
		const supported = this.session.getAvailableThinkingLevels();
		const current = this.session.thinkingLevel;
		if (supported.length > 0 && !supported.includes(current)) {
			state.thinkingLevel = supported[supported.length - 1];
		}
		this.onSessionStateChange?.(this.session);
		this.emit({ type: "snapshot" });
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		// Same non-persisting rationale as setModel.
		this.session.state.thinkingLevel = thinkingLevel;
		this.onSessionStateChange?.(this.session);
		this.emit({ type: "snapshot" });
	}

	subscribe(listener: (event: WorkerRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * In-process observation (the panel). Deliberately NOT `subscribe`: dispose()
	 * clears the control-surface listeners when an observer detaches, and a panel
	 * watcher must outlive that. Watchers are dropped only by shutdown(), when the
	 * worker is done.
	 */
	watch(listener: () => void): () => void {
		this.watchers.add(listener);
		return () => this.watchers.delete(listener);
	}

	async dispose(): Promise<void> {
		// An observer detaching ends its control-surface subscription; the worker
		// itself survives: it runs for the parent, not for the observer. Only the
		// listener set goes.
		this.listeners.clear();
	}

	/** Tear down for real. Called by the extension when the worker settles. */
	shutdown(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		this.listeners.clear();
		this.watchers.clear();
	}

	// ------------------------------------------------------------ internals

	private recomputePhase(): void {
		this.phase = this.currentPhase("idle");
	}

	private emit(event: WorkerRuntimeEvent): void {
		if (event.type === "snapshot") this.revision += 1;
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// An observer's failure must not disturb the worker.
			}
		}
		for (const watcher of [...this.watchers]) {
			try {
				watcher();
			} catch {
				// Same containment as above.
			}
		}
	}

	private messageId(message: SessionMessage): string {
		let id = this.msgIds.get(message);
		if (!id) {
			id = `m-${++this.msgSeq}`;
			this.msgIds.set(message, id);
		}
		return id;
	}

	private steerId(text: string): string {
		let id = this.steerIds.get(text);
		if (!id) {
			id = `steer-${++this.msgSeq}`;
			this.steerIds.set(text, id);
		}
		return id;
	}

	private toolItem(input: ToolItemInput & { status: "running" }): Extract<TranscriptToolItem, { status: "running" }>;
	private toolItem(
		input: ToolItemInput & { status: "complete" | "error" },
	): Extract<TranscriptToolItem, { status: "complete" | "error" }>;
	private toolItem(input: ToolItemInput): TranscriptToolItem {
		const base = {
			id: input.toolCallId,
			role: "tool" as const,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			input: transcriptJsonValue(input.args ?? {}),
			content: input.content ?? [],
			timestamp: input.timestamp,
		};
		if (input.status === "running") {
			return { ...base, status: "running" as const, isError: false };
		}
		const optional: { details?: unknown; usage?: AiUsage } = {};
		if (input.details !== undefined) optional.details = input.details;
		if (input.usage !== undefined) optional.usage = input.usage;
		return input.status === "error"
			? { ...base, ...optional, status: "error", isError: true }
			: { ...base, ...optional, status: "complete", isError: false };
	}

	private emitAssistantDeltas(message: AssistantSessionMessage): void {
		const stream = this.stream;
		if (!stream) return;
		message.content.forEach((part, index) => {
			if (part.type !== "text" && part.type !== "thinking") return;
			const text = part.type === "text" ? part.text : part.thinking;
			const previous = stream.lens.get(index) ?? 0;
			if (text.length > previous) {
				this.emit({
					type: "progress",
					progress: {
						type: "assistant_delta",
						messageId: stream.id,
						contentIndex: index,
						kind: part.type,
						delta: text.slice(previous),
					},
				});
				stream.lens.set(index, text.length);
			}
		});
	}

	private onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				const { message } = event;
				if (message.role === "user") {
					const item = userTranscriptItem(message, this.messageId(message));
					this.emit({
						type: "progress",
						progress: { type: "item_started", item },
					});
				} else if (message.role === "assistant") {
					const id = `m-${++this.msgSeq}`;
					this.msgIds.set(message, id);
					this.stream = { id, lens: new Map() };
					const item = assistantTranscriptItem(message, id);
					if (item) {
						this.emit({
							type: "progress",
							progress: { type: "item_started", item },
						});
					}
				}
				break;
			}
			case "message_update":
				if (event.message.role === "assistant") {
					this.emitAssistantDeltas(event.message);
				}
				break;
			case "message_end": {
				const { message } = event;
				if (message.role === "assistant") {
					const id = this.stream?.id ?? this.messageId(message);
					this.msgIds.set(message, id);
					try {
						const item = assistantTranscriptItem(message, id);
						if (item && item.status !== "streaming") {
							this.emit({
								type: "progress",
								progress: { type: "item_finished", item },
							});
						}
					} catch {
						// Deferred stop reasons stay available through snapshots.
					}
					this.stream = null;
					this.emit({ type: "snapshot" });
				} else if (message.role === "user") {
					this.emit({ type: "snapshot" });
				}
				break;
			}
			case "tool_execution_start": {
				this.liveTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
				});
				const item = this.toolItem({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					content: [],
					status: "running",
					timestamp: Date.now(),
				});
				this.emit({
					type: "progress",
					progress: { type: "item_started", item },
				});
				break;
			}
			case "tool_execution_update": {
				const partial = event.partialResult as { content?: TranscriptContentPart[] } | undefined;
				this.liveTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
					content: partial?.content,
				});
				const item = this.toolItem({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					content: partial?.content,
					status: "running",
					timestamp: Date.now(),
				});
				this.emit({
					type: "progress",
					progress: { type: "item_updated", item },
				});
				break;
			}
			case "tool_execution_end": {
				const started = this.liveTools.get(event.toolCallId);
				this.liveTools.delete(event.toolCallId);
				const result = event.result as { content?: TranscriptContentPart[]; details?: unknown; usage?: AiUsage };
				const item = this.toolItem({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: started?.args,
					content: result?.content,
					status: event.isError ? "error" : "complete",
					details: result?.details,
					usage: result?.usage,
					timestamp: Date.now(),
				});
				this.emit({
					type: "progress",
					progress: { type: "item_finished", item },
				});
				break;
			}
			case "agent_start":
				this.phase = "turn";
				if (this.abortRequested) {
					// An abort landed during preflight and found nothing to cancel.
					// The run is real now; kill it rather than let a ghost run to
					// completion spending tokens nobody will collect.
					this.session.clearQueue();
					this.session.abort().catch(() => {
						// Best-effort; the settle path records the outcome either way.
					});
				}
				this.emit({ type: "snapshot" });
				break;
			case "agent_end":
				this.emit({ type: "snapshot" });
				break;
			case "agent_settled":
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "queue_update":
				this.emit({ type: "snapshot" });
				break;
			case "compaction_start":
				this.compactionCount += 1;
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "compaction_end":
				this.compactionCount = Math.max(0, this.compactionCount - 1);
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "auto_retry_start":
				this.retryActive = true;
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "auto_retry_end":
				this.retryActive = false;
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "summarization_retry_attempt_start":
				if (event.source === "branchSummary") {
					this.branchSummaryActive = true;
					this.recomputePhase();
					this.emit({ type: "snapshot" });
				}
				break;
			case "summarization_retry_finished":
				// This event covers both summarization kinds and has no source
				// discriminator; preserve branch-summary phase during compaction retry.
				if (this.compactionCount === 0) this.branchSummaryActive = false;
				this.recomputePhase();
				this.emit({ type: "snapshot" });
				break;
			case "thinking_level_changed":
			case "session_info_changed":
				this.emit({ type: "snapshot" });
				break;
			default:
				break;
		}
	}
}
