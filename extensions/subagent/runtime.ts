/**
 * Worker runtime adapter: presents a coding-agent AgentSession through pi's
 * PiSessionRuntime surface so a worker can be served over PiServer as a real
 * protocol session. Released Pi 0.84.2 has no client path that consumes this
 * socket (see server.ts). Upstream development includes unreleased experimental
 * surfaces. This extension targets released APIs and keeps this file as its one
 * replaceable runtime-to-protocol boundary.
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
 *   priority over `isStreaming`; without this the server can dispose a compacting
 *   worker.
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE PI ADAPTER
 * ---------------------------------------------------------------------------
 *
 * This file converts released AgentSession state and events into protocol v1.
 * Downstream files consume protocol transcript items, not Pi message objects.
 * Released `modelRuntime.getModel()` resolves a model without persisting an
 * operator default. No feature probe, speculative adapter, or dual path lives
 * here.
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
import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	PiServerError,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	type SteerInput,
	sanitizeProtocolDetails,
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolToolResultMessage,
	toProtocolUsage,
	toProtocolUserMessage,
} from "@earendil-works/pi-server";

type SessionMessage = AgentSession["state"]["messages"][number];
type AssistantSessionMessage = Extract<SessionMessage, { role: "assistant" }>;
type ToolCallPart = Extract<
	AssistantSessionMessage["content"][number],
	{ type: "toolCall" }
>;
type ToolContent = ToolTranscriptItem["content"];
type ToolResultPayload = {
	content?: ToolContent;
	details?: unknown;
	usage?: AiUsage;
};
type ToolItemInput = {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	content?: ToolContent;
	status: "running" | "complete" | "error";
	details?: unknown;
	usage?: AiUsage;
	timestamp: number;
};
type ToolItemWithStatus<Status extends ToolItemInput["status"]> = Extract<
	ToolTranscriptItem,
	{ status: Status }
>;

/**
 * Convert pi messages to protocol-v1 transcript items. The one conversion used
 * by BOTH transcript paths — a live worker's in-memory state and a terminal
 * worker's session file — so there is exactly one reader of pi's message shape.
 *
 * Roles with no protocol-v1 representation are dropped: `custom`,
 * `bashExecution`, `branchSummary`, and `compactionSummary`, as are assistant
 * messages whose stopReason is `deferred` or `error` with an empty
 * `errorMessage` (the mapper throws on those; only pi-ai's `faux` test provider
 * ever produces one). A `toolResult`
 * with no matching call is dropped because protocol v1 has no way to express a
 * result without its call — and a console renders tool output inside the call's
 * box anyway, so an orphan result was never visible.
 */
export function buildTranscript(
	messages: SessionMessage[],
	idFor: (message: SessionMessage) => string,
): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const toolCalls = new Map<string, ToolCallPart>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall") toolCalls.set(part.id, part);
		}
	}
	for (const message of messages) {
		if (message.role === "user") {
			try {
				items.push(toProtocolUserMessage(message, { id: idFor(message) }));
			} catch {
				// A malformed message is skipped, never fatal to a transcript view.
			}
		} else if (message.role === "assistant") {
			try {
				const item = toProtocolAssistantMessage(message, {
					id: idFor(message),
				});
				// The released mapper can return a non-object for an unknown stopReason
				// despite its declared return type. Keep that boundary out of consumers.
				if (item && typeof item === "object") items.push(item);
			} catch {
				// stopReason "deferred" (and error with an empty errorMessage) throw.
			}
		} else if (message.role === "toolResult") {
			const call = toolCalls.get(message.toolCallId);
			if (!call) continue;
			try {
				items.push(
					toProtocolToolResultMessage(message, {
						id: idFor(message),
						call,
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
export function transcriptFromMessages(
	messages: SessionMessage[],
): TranscriptItem[] {
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

export interface WorkerRuntimeOptions {
	session: AgentSession;
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
}

/** Adapts one worker AgentSession to PiSessionRuntime. */
export class WorkerRuntime implements PiSessionRuntime {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;

	private readonly session: AgentSession;
	private revision = 0;
	private readonly listeners = new Set<
		(event: PiSessionRuntimeEvent) => void
	>();
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
		{ toolName: string; args: unknown; content?: ToolContent }
	>();
	private phase: SessionPhase = "idle";
	private compactionCount = 0;
	private retryActive = false;
	private branchSummaryActive = false;
	/**
	 * Set by abort() and cleared by prompt(). AgentSession.prompt awaits an async
	 * preflight (auth refresh, compaction, busy checks) before a cancellable run
	 * exists, and Agent.abort() is a no-op while no run is active — so an abort
	 * arriving in that window is silently lost and the run starts anyway. This
	 * flag carries the intent forward to `agent_start`, which re-issues it.
	 */
	private abortRequested = false;
	private unsubscribe: (() => void) | null = null;

	constructor(options: WorkerRuntimeOptions) {
		this.session = options.session;
		this.id = options.id;
		this.name = options.name;
		this.cwd = options.cwd;
		this.createdAt = options.createdAt;
		this.unsubscribe = this.session.subscribe((event) => {
			try {
				this.onSessionEvent(event);
			} catch {
				// AgentSession invokes listeners without containment. A malformed
				// message or protocol conversion must not escape into the worker run.
			}
		});
	}

	// ------------------------------------------------------------ PiSessionRuntime

	/** Released AgentSession state used for transcript snapshots. */
	private agentState(): AgentSession["state"] {
		return this.session.state;
	}

	snapshot(): SessionSnapshot {
		const state = this.agentState();
		const items = buildTranscript(state.messages, (message) =>
			this.messageId(message),
		);
		const streaming = state.streamingMessage;
		if (streaming?.role === "assistant") {
			const id = this.stream?.id ?? this.messageId(streaming);
			try {
				const item = toProtocolAssistantMessage(streaming, { id });
				// The mapper returns (rather than throws) a raw stopReason when it is
				// missing or unknown, so only object results can enter the transcript.
				if (item && typeof item === "object") items.push(item);
				else {
					try {
						const pending = toProtocolAssistantMessage(
							{ ...streaming, stopReason: "pending" },
							{ id },
						);
						if (pending && typeof pending === "object") items.push(pending);
					} catch {
						// A missing/unknown stopReason fallback can still be unmappable.
					}
				}
			} catch {
				// A provider stream can emit a partial toolCall before its id and name.
				// identifier("") throws and would drop the whole in-flight item.
				// Drop only the
				// un-addressable toolCall parts and retry so the rest still renders.
				const content = streaming.content;
				const pruned = content.filter(
					(part) => part.type !== "toolCall" || Boolean(part.id && part.name),
				);
				if (pruned.length !== content.length) {
					try {
						const item = toProtocolAssistantMessage(
							{ ...streaming, content: pruned },
							{ id },
						);
						if (item && typeof item === "object") items.push(item);
					} catch {
						// Still unmappable; skip the in-flight item for this snapshot.
					}
				}
			}
		}
		// Synthetic running items carry live partial output to the panel; the real
		// toolResult replaces them at tool_execution_end.
		for (const [toolCallId, partial] of this.liveTools) {
			const hasToolResult = items.some(
				(item) => item.role === "tool" && item.toolCallId === toolCallId,
			);
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
		const queuedSteer = steerTexts.map((text, index) => ({
			id: this.steerId(text),
			role: "user" as const,
			content: [{ type: "text" as const, text }],
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
			model: model
				? { provider: model.provider, id: model.id }
				: { provider: "unknown", id: "unknown" },
			thinkingLevel: this.session.thinkingLevel ?? "off",
			// PiServer overrides attached/locked/phase in its normalized snapshot.
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
		if (this.session.isStreaming) return "turn";
		return fallback;
	}

	getPhase(): SessionPhase {
		return this.currentPhase(this.phase);
	}

	async prompt(input: PromptInput): Promise<void> {
		if (this.getPhase() !== "idle") {
			throw new PiServerError("busy", "the worker is already running a turn");
		}
		// Optimistic: AgentSession preflight is async; events confirm the phase.
		this.abortRequested = false;
		this.phase = "turn";
		try {
			await this.session.prompt(input.text, {
				expandPromptTemplates: false,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/already processing|compaction/.test(message)) {
				throw new PiServerError("busy", message);
			}
			throw error;
		} finally {
			this.abortRequested = false;
			this.recomputePhase();
		}
	}

	async steer(input: SteerInput): Promise<void> {
		// AgentSession queues steers unconditionally: mid-run they are drained after
		// the current tool batch, before the next model call; when queued during
		// preflight or while idle, they are delivered at the start of the next run,
		// before its first model call. That is the accepted behavior here, and it
		// deviates from the protocol's reject-when-idle contract on purpose.
		await this.session.steer(input.text);
		this.emit({ type: "snapshot" });
	}

	async abort(): Promise<void> {
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
			throw new PiServerError(
				"invalid_request",
				`unknown model ${ref.provider}/${ref.id}`,
			);
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
		this.emit({ type: "snapshot" });
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		// Same non-persisting rationale as setModel.
		this.session.state.thinkingLevel = thinkingLevel;
		this.emit({ type: "snapshot" });
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * In-process observation (the panel). Deliberately NOT `subscribe`: PiServer
	 * disposes a runtime when its last remote client detaches, and dispose()
	 * clears the server-facing listeners. A watcher must outlive that — an
	 * operator attaching and detaching a pi-client must not silently freeze the
	 * panel. Watchers are dropped only by shutdown(), when the worker is done.
	 */
	watch(listener: () => void): () => void {
		this.watchers.add(listener);
		return () => this.watchers.delete(listener);
	}

	async dispose(): Promise<void> {
		// PiServer disposes a runtime when the last client detaches while idle. The
		// worker must survive that: it is running for the parent, not for the
		// observer. Only the server-facing listeners go.
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

	private emit(event: PiSessionRuntimeEvent): void {
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

	private toolItem(
		input: ToolItemInput & { status: "running" },
	): ToolItemWithStatus<"running">;
	private toolItem(
		input: ToolItemInput & { status: "complete" | "error" },
	): ToolItemWithStatus<"complete"> | ToolItemWithStatus<"error">;
	private toolItem(input: ToolItemInput): ToolTranscriptItem;
	private toolItem(input: ToolItemInput): ToolTranscriptItem {
		const base = {
			id: input.toolCallId,
			role: "tool" as const,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			input: toProtocolJsonValue(input.args ?? {}),
			content: input.content ?? [],
			timestamp: input.timestamp,
		};
		if (input.status === "running") {
			return { ...base, status: "running", isError: false };
		}
		const optional: {
			details?: ReturnType<typeof sanitizeProtocolDetails>;
			usage?: ReturnType<typeof toProtocolUsage>;
		} = {};
		const details = sanitizeProtocolDetails(input.details);
		const usage = toProtocolUsage(input.usage);
		if (details !== undefined) optional.details = details;
		if (usage !== undefined) optional.usage = usage;
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
					const item = toProtocolUserMessage(message, {
						id: this.messageId(message),
					});
					this.emit({
						type: "progress",
						progress: { type: "item_started", item },
					});
				} else if (message.role === "assistant") {
					const id = `m-${++this.msgSeq}`;
					this.msgIds.set(message, id);
					this.stream = { id, lens: new Map() };
					const item = toProtocolAssistantMessage(message, { id });
					this.emit({
						type: "progress",
						progress: { type: "item_started", item },
					});
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
						const item = toProtocolAssistantMessage(message, { id });
						if (item.status !== "streaming") {
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
				// SAFETY: Pi 0.84.2 declares partialResult as any, while every tool
				// update uses the public AgentToolResult content contract.
				const partial = event.partialResult as ToolResultPayload;
				this.liveTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
					content: partial.content,
				});
				const item = this.toolItem({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					content: partial.content,
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
				// SAFETY: Pi 0.84.2 declares result as any, while tool execution
				// supplies the public AgentToolResult content/details/usage contract.
				const result = event.result as ToolResultPayload;
				const item = this.toolItem({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: started?.args,
					content: result.content,
					status: event.isError ? "error" : "complete",
					details: result.details,
					usage: result.usage,
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
