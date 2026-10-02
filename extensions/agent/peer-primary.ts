/**
 * Ordinary-primary projection for the peer window. The observer reads the real
 * session manager read-only and the public message and tool events; it creates
 * no session, writer, or model loop. Committed blocks come from the canonical
 * session projection and live material is reconciled against it by message
 * identity, so a completed partial never appears twice.
 */
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProjectedSessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import type { PeerDescriptor, PrimaryLiveTool, PrimaryObserver, PrimarySnapshot, PrimarySubmitMode } from "./peer-contract.ts";

/** The session-manager surface the projection needs; the real manager satisfies it. */
export interface PrimarySessionReader {
	getSessionId(): string;
	getSessionName?(): string | undefined;
	getCwd?(): string;
	getLeafId?(): string | null;
	buildSessionProjection(): SessionProjection;
}

const MAX_LIVE_TEXT = 16_384;

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") return [(part as { text: string }).text];
		return [];
	}).join("\n");
}

function livePart(part: unknown): TextContent | ImageContent | undefined {
	if (!part || typeof part !== "object" || !("type" in part)) return undefined;
	const type = (part as { type: string }).type;
	if (type === "text") return { type: "text", text: String((part as { text?: unknown }).text ?? "").slice(0, MAX_LIVE_TEXT) };
	if (type === "image") return { type: "image", data: String((part as { data?: unknown }).data ?? ""), mimeType: String((part as { mimeType?: unknown }).mimeType ?? "image/png") };
	return undefined;
}

function liveText(value: unknown): (TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value.slice(0, MAX_LIVE_TEXT) }];
	if (value === undefined || value === null) return [{ type: "text", text: "" }];
	return [{ type: "text", text: (JSON.stringify(value) ?? "").slice(0, MAX_LIVE_TEXT) }];
}

/** Bounded display content for a live tool result that has no committed message yet. */
function liveContent(value: unknown): (TextContent | ImageContent)[] {
	try {
		if (!value || typeof value !== "object" || !("content" in value)) return liveText(value);
		const raw = (value as { content?: unknown }).content;
		if (typeof raw === "string") return [{ type: "text", text: raw.slice(0, MAX_LIVE_TEXT) }];
		if (!Array.isArray(raw)) return liveText(value);
		const parts = raw.map(livePart).filter((part): part is TextContent | ImageContent => part !== undefined);
		return parts.length ? parts : liveText(value);
	} catch {
		return [{ type: "text", text: "[Unreadable tool output]" }];
	}
}

function isDisplayMessage(message: unknown): message is Message {
	return Boolean(message) && typeof message === "object" && ["user", "assistant", "toolResult", "system"].includes(String((message as { role?: unknown }).role));
}

function timestampOf(entry: { timestamp?: string }, fallback = 0): number {
	const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function displayMessage(message: unknown, source: ProjectedSessionEntry["sourceEntry"], now: number): Message | undefined {
	if (isDisplayMessage(message)) return message;
	const text = textFromContent((message as { content?: unknown }).content);
	return text === "" ? undefined : { role: "user", content: text, timestamp: timestampOf(source, now) };
}

function compactionBlock(source: ProjectedSessionEntry["sourceEntry"], messages: readonly unknown[], now: number): AgentConversationEntry | undefined {
	const blocks = messages.map((message) => displayMessage(message, source, now)).filter((message): message is Message => message !== undefined);
	return blocks.length ? { id: source.id, kind: "pi.compaction", model: blocks } : undefined;
}

function blockKind(messages: readonly Message[], sourceType: string): string {
	if (messages.some((message) => message.role === "toolResult")) return "pi.tool-result";
	if (messages.some((message) => message.role === "assistant")) return "pi.assistant";
	if (sourceType === "custom_message") return "pi.custom_message";
	if (sourceType === "branch_summary") return "pi.branch";
	return "pi.user";
}

/** Stored custom message fields the transcript passes to a card renderer. */
function customData(source: ProjectedSessionEntry["sourceEntry"]): { customType: string; content: unknown; details?: unknown } | undefined {
	if (source.type !== "custom_message") return undefined;
	return { customType: source.customType, content: source.content, details: source.details };
}

/**
 * Convert one projected session entry into the window's block shape. Unknown
 * message roles keep their text as a user message; the window never invents
 * executable content.
 */
function projectedBlock(entry: ProjectedSessionEntry, now: number): AgentConversationEntry | undefined {
	const source = entry.sourceEntry;
	const visible = entry.messages.filter((message) => (message as { role?: unknown }).role !== "system");
	if (source.type === "compaction") return compactionBlock(source, visible, now);
	const messages = visible.map((message) => displayMessage(message, source, now)).filter((message): message is Message => message !== undefined);
	if (!messages.length) return undefined;
	const kind = blockKind(messages, source.type);
	const data = kind === "pi.custom_message" ? customData(source) : undefined;
	return { id: source.id, kind, model: messages, ...(data ? { data } : {}) };
}

export interface PrimaryProjection {
	entries: AgentConversationEntry[];
	revision: string;
	/** Retained assistant usage cost across the projected branch. */
	cost: number;
	/** True when any assistant usage cost is missing or unreadable. */
	partialCost: boolean;
}

function usageCost(messages: readonly unknown[]): { cost: number; partial: boolean } {
	let cost = 0;
	let partial = false;
	for (const message of messages) {
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const total = (message as { usage?: { cost?: { total?: unknown } } }).usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total)) cost += total;
		else partial = true;
	}
	return { cost, partial };
}

/** Build committed display blocks from the canonical session projection. */
export function projectPrimary(sessionManager: PrimarySessionReader, now = Date.now()): PrimaryProjection {
	const projection = sessionManager.buildSessionProjection();
	const entries: AgentConversationEntry[] = [];
	for (const entry of projection.entries) {
		const block = projectedBlock(entry, now);
		if (block) entries.push(block);
	}
	const last = entries[entries.length - 1]?.id ?? "empty";
	const revision = `${sessionManager.getSessionId()}:${sessionManager.getLeafId?.() ?? "leaf"}:${entries.length}:${last}`;
	const { cost, partial } = usageCost(projection.messages);
	return { entries, revision, cost, partialCost: partial };
}

function messageIdentity(message: { role?: unknown; timestamp?: unknown }): string {
	return `${String(message.role)}:${String(message.timestamp ?? "")}`;
}

function messageText(message: Message): string {
	return typeof message.content === "string" ? message.content : textFromContent(message.content);
}

interface PendingInput {
	id: string;
	text: string;
}

interface LiveState {
	assistant?: AssistantMessage;
	tools: Map<string, PrimaryLiveTool>;
	pending: PendingInput[];
	busy: boolean;
}

function createLive(): LiveState {
	return { tools: new Map(), pending: [], busy: false };
}

class PrimaryObserverImpl implements PrimaryObserver {
	private ctx?: ExtensionContext;
	private pi?: ExtensionAPI;
	private readonly listeners = new Set<() => void>();
	private live = createLive();
	private projection?: PrimaryProjection;
	private projectionDirty = true;
	private liveVersion = 0;
	private era = 0;
	private pendingCount = 0;
	private modelOverride?: { provider: string; modelId: string };
	private thinkingOverride?: string;
	private nameOverride?: string;

	attach(ctx: ExtensionContext, pi?: ExtensionAPI): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const changed = this.ctx !== undefined && this.ctx.sessionManager.getSessionId() !== sessionId;
		if (changed) {
			this.live = createLive();
			this.projection = undefined;
			this.projectionDirty = true;
			this.era++;
		}
		this.ctx = ctx;
		if (pi) this.pi = pi;
		this.emit();
	}

	observe(event: { type: string }): void {
		const data = event as Record<string, unknown>;
		this.observeMessage(event.type, data);
		this.observeTool(event.type, data);
		this.observeMeta(event.type, data);
		this.liveVersion++;
		this.emit();
	}

	private observeMessage(type: string, data: Record<string, unknown>): void {
		if (type === "message_start" || type === "message_update") {
			const message = data.message as AssistantMessage | undefined;
			if (message?.role === "assistant") this.live.assistant = message;
			return;
		}
		if (type !== "message_end") return;
		const message = data.message as Message | undefined;
		if (message?.role === "assistant" || message?.role === "user" || message?.role === "toolResult") this.projectionDirty = true;
	}

	private observeTool(type: string, data: Record<string, unknown>): void {
		if (!type.startsWith("tool_execution_")) return;
		const toolCallId = String(data.toolCallId ?? "");
		if (type === "tool_execution_start") {
			if (toolCallId) this.live.tools.set(toolCallId, { toolCallId, toolName: String(data.toolName ?? "tool"), args: data.args });
			return;
		}
		const tool = this.live.tools.get(toolCallId);
		if (!tool) return;
		if (type === "tool_execution_update") tool.partial = data.partialResult;
		else if (type === "tool_execution_end") { tool.result = data.result; tool.isError = data.isError === true; }
	}

	private observeMeta(type: string, data: Record<string, unknown>): void {
		switch (type) {
			case "agent_start": this.live.busy = true; return;
			case "agent_end": this.live.busy = false; this.projectionDirty = true; return;
			case "turn_end": this.projectionDirty = true; return;
			case "session_compact": this.projectionDirty = true; return;
			case "model_select": {
				const model = data.model as { provider?: unknown; id?: unknown } | undefined;
				if (model && typeof model.provider === "string" && typeof model.id === "string") this.modelOverride = { provider: model.provider, modelId: model.id };
				return;
			}
			case "thinking_level_select":
				if (typeof data.level === "string") this.thinkingOverride = data.level;
				return;
			case "session_info_changed":
				this.nameOverride = typeof data.name === "string" ? data.name : undefined;
				return;
			default: return;
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	sendPlain(text: string, mode: PrimarySubmitMode): void {
		if (!this.pi) throw new Error("The primary is not attached to this Pi session");
		const busy = this.ctx ? !this.ctx.isIdle() : false;
		if (mode === "steer") this.pi.sendUserMessage(text, { deliverAs: "steer" });
		else if (mode === "followUp") this.pi.sendUserMessage(text, { deliverAs: "followUp" });
		else if (busy) this.pi.sendUserMessage(text, { deliverAs: "followUp" });
		else this.pi.sendUserMessage(text);
		this.live.pending.push({ id: `pending-${++this.pendingCount}`, text });
		this.liveVersion++;
		this.emit();
	}

	handoffToNative(text: string): string {
		const previous = this.ctx?.ui.getEditorText() ?? "";
		this.ctx?.ui.setEditorText(text);
		return previous;
	}

	nativeDraft(): string {
		return this.ctx?.ui.getEditorText() ?? "";
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* One listener cannot block the others. */ }
		}
	}

	private currentProjection(): PrimaryProjection {
		if (!this.projection || this.projectionDirty) {
			this.projection = this.ctx ? projectPrimary(this.ctx.sessionManager) : { entries: [], revision: "detached", cost: 0, partialCost: false };
			this.projectionDirty = false;
		}
		return this.projection;
	}

	private assistantCommitted(entries: readonly AgentConversationEntry[], assistant: AssistantMessage): boolean {
		const identity = messageIdentity(assistant);
		return entries.some((entry) => (entry.model ?? []).some((message) => messageIdentity(message) === identity));
	}

	private reconcile(entries: readonly AgentConversationEntry[]): void {
		const committedResults = new Set<string>();
		const committedUserTexts: string[] = [];
		for (const entry of entries) {
			for (const message of entry.model ?? []) {
				if (message.role === "toolResult") committedResults.add(message.toolCallId);
				else if (message.role === "user") committedUserTexts.push(messageText(message));
			}
		}
		for (const id of [...this.live.tools.keys()]) if (committedResults.has(id)) this.live.tools.delete(id);
		const assistant = this.live.assistant;
		if (assistant && this.assistantCommitted(entries, assistant)) this.live.assistant = undefined;
		this.reconcilePending(committedUserTexts);
	}

	/** Drop one optimistic input per matching committed user message. */
	private reconcilePending(committedUserTexts: readonly string[]): void {
		if (!this.live.pending.length) return;
		const available = [...committedUserTexts];
		this.live.pending = this.live.pending.filter((pending) => {
			const index = available.indexOf(pending.text);
			if (index < 0) return true;
			available.splice(index, 1);
			return false;
		});
	}

	private liveBlocks(entries: readonly AgentConversationEntry[]): AgentConversationEntry[] {
		const blocks: AgentConversationEntry[] = [];
		const assistant = this.live.assistant;
		if (assistant && !this.assistantCommitted(entries, assistant)) blocks.push({ id: `live-assistant-${this.era}`, kind: "pi.assistant", model: [assistant] });
		for (const pending of this.live.pending) {
			blocks.push({ id: `live-input-${pending.id}`, kind: "pi.user", model: [{ role: "user", content: pending.text, timestamp: 0 }] });
		}
		for (const tool of this.live.tools.values()) {
			const content = liveContent(tool.result !== undefined ? tool.result : tool.partial);
			const message: ToolResultMessage = { role: "toolResult", toolCallId: tool.toolCallId, toolName: tool.toolName, content, isError: tool.isError === true, timestamp: 0 };
			blocks.push({ id: `live-tool-${tool.toolCallId}`, kind: "pi.tool-result", model: [message] });
		}
		return blocks;
	}

	private anchor(entries: readonly AgentConversationEntry[]): number {
		if (!this.live.tools.size) return entries.length;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.kind !== "pi.assistant") continue;
			const ownsRunning = (entry.model ?? []).some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && this.live.tools.has(part.id)));
			if (ownsRunning) return index;
		}
		return entries.length;
	}

	private descriptor(projection: PrimaryProjection): PeerDescriptor {
		const ctx = this.ctx;
		const sessionId = ctx?.sessionManager.getSessionId() ?? "primary";
		const model = this.modelOverride ?? (ctx?.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined);
		const thinking = this.thinkingOverride ?? ctx?.thinkingLevel;
		const name = this.nameOverride ?? ctx?.sessionManager.getSessionName?.() ?? "";
		return {
			id: sessionId,
			kind: "primary",
			name: name.trim() || "this Pi",
			cwd: ctx?.cwd ?? ctx?.sessionManager.getCwd?.() ?? ".",
			model: model ? `${model.provider}/${model.modelId}` : undefined,
			thinkingLevel: thinking,
			state: this.live.busy ? "working" : "idle",
			cost: projection.cost,
			partialCost: projection.partialCost || undefined,
		};
	}

	snapshot(): PrimarySnapshot {
		const projection = this.currentProjection();
		this.reconcile(projection.entries);
		const anchor = this.anchor(projection.entries);
		const head = projection.entries.slice(0, anchor);
		const live = [...projection.entries.slice(anchor), ...this.liveBlocks(projection.entries)];
		return {
			descriptor: this.descriptor(projection),
			entries: head,
			revision: `${projection.revision}|${anchor}`,
			live,
			liveRevision: `live-${this.liveVersion}`,
			busy: this.live.busy,
		};
	}
}

/** Create one observer for the process; bind it to the public events once. */
export function createPrimaryObserver(): PrimaryObserver {
	return new PrimaryObserverImpl();
}

/**
 * Forward the public primary events to one observer. The coordinator calls
 * this once at extension registration; Pi allows several handlers per event.
 */
export function bindPrimaryObserver(pi: ExtensionAPI, observer: PrimaryObserver): void {
	pi.on("session_start", (_event, ctx) => observer.attach(ctx, pi));
	const forward = (event: unknown): void => observer.observe(event as { type: string });
	pi.on("message_start", forward);
	pi.on("message_update", forward);
	pi.on("message_end", forward);
	pi.on("tool_execution_start", forward);
	pi.on("tool_execution_update", forward);
	pi.on("tool_execution_end", forward);
	pi.on("turn_end", forward);
	pi.on("agent_start", forward);
	pi.on("agent_end", forward);
	pi.on("model_select", forward);
	pi.on("thinking_level_select", forward);
	pi.on("session_info_changed", forward);
	pi.on("session_compact", forward);
}
