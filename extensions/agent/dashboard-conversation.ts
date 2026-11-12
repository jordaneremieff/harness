import { stripVTControlCharacters } from "node:util";
import { AGENT_INPUT_KIND, isInputKind } from "./input-entry.ts";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { NestedToolSlot } from "@earendil-works/pi-durable";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { readingGeometry } from "./dashboard-layout.ts";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import type { AgentReadingState } from "./dashboard-state.ts";
import { parseCommunicationView, type Communication } from "./communication.ts";
import { bindCardDisclosure, compactCommunicationRenderer, createAgentToolCards, type AgentCardLookup } from "./tool-cards.ts";

const agentCardNames = new Set(Object.keys(createAgentToolCards()));

export function cleanDashboardText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

/** Blank rows at a component's edge are removed; the transcript owns the one shared gap. */
function trimBlankRows(lines: string[]): { lines: string[]; top: number } {
	const blank = (line: string) => stripVTControlCharacters(line).trim() === "";
	let start = 0;
	let end = lines.length;
	while (start < end && blank(lines[start])) start++;
	while (end > start && blank(lines[end - 1])) end--;
	return { lines: lines.slice(start, end), top: start };
}

function fitText(line: string, width: number): string {
	const value = truncateToWidth(line, Math.max(1, width), "…");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/** Render callbacks receive sanitized display data, never signatures or image payloads. */
function displayValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		const clean = cleanDashboardText(value);
		return clean.length > 65536 ? `${clean.slice(0, 65536)}\n[Display limited to 65,536 characters]` : clean;
	}
	if (depth > 20) return "[Nested value omitted]";
	if (Array.isArray(value)) return value.map((item) => displayValue(item, depth + 1));
	if (value && typeof value === "object") return displayObject(value, depth);
	return value;
}
function displayObject(value: object, depth: number): unknown {
	if ("type" in value && value.type === "image") return { type: "text", text: "[Image]" };
	if ("type" in value && value.type === "thinking" && "redacted" in value && value.redacted)
		return { type: "text", text: "[Redacted thinking]" };
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !["signature", "thinkingSignature", "textSignature"].includes(key))
			.map(([key, item]) => [key, displayValue(item, depth + 1)]),
	);
}

export interface ConversationBlock {
	id: string;
	component: Component;
	/** Blocks from one entry, and the tool calls it issued, form one visual step. */
	step?: string;
}
export interface ConversationDocument {
	lines: string[];
	anchors: Array<{ id: string; line: number }>;
}
/** Pi has no expansion getter; observe its public setter without replacing native click behavior. */
class ReadingToolComponent extends ToolExecutionComponent {
	choice = false;
	argumentsError?: string;
	onInvalidate?: () => void;
	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.argumentsError === undefined) return lines;
		const note = ` · Arguments error: ${cleanDashboardText(this.argumentsError).replace(/\s+/gu, " ")}`;
		const index = lines.findIndex((line) => stripVTControlCharacters(line).trim().length > 0);
		if (index < 0) return [truncateToWidth(note.trim(), Math.max(1, width), "…")];
		const next = [...lines];
		next[index] = truncateToWidth(`${next[index]}${note}`, Math.max(1, width), "…");
		return next;
	}
	override invalidate(): void {
		super.invalidate();
		this.onInvalidate?.();
	}
	override setExpanded(expanded: boolean): void {
		this.choice = expanded;
		super.setExpanded(expanded);
		this.onInvalidate?.();
	}
}
function isItemClick(event: TuiMouseEvent): boolean {
	return event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl && (event.clickCount ?? 1) === 1;
}

function contentText(content: Message["content"], includeImageLabels = true): string {
	if (typeof content === "string") return content;
	return content
		.flatMap((part) => (part.type === "text" ? [part.text] : includeImageLabels && part.type === "image" ? ["[Image]"] : []))
		.join("\n");
}

/** Pi renders text, images, thinking and tool calls; a tool result always has its own card. */
function messageIsRenderable(message: Message): boolean {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	return content.some((part) => {
		switch (part.type) {
			case "text":
				return part.text.trim().length > 0;
			case "image":
				return true;
			case "toolCall":
				return true;
			case "thinking":
				return part.thinking.trim().length > 0 || part.redacted === true;
			default:
				return false;
		}
	});
}

/**
 * Entries the conversation surface can show. Assistant entries that carry only
 * tool calls or thinking keep their tool cards and results attached; native
 * kinds without visible content never consume the load limit.
 */
export function renderableEntries(entries: readonly AgentConversationEntry[]): AgentConversationEntry[] {
	return entries.filter((entry) => {
		if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") return true;
		if (entry.kind === "pi.system") return false;
		if (entry.kind === "pi.custom_message" && (entry.data as { display?: boolean } | undefined)?.display === false)
			return false;
		if (entry.kind === "pi.tool-result") return true;
		return (entry.model ?? []).some(messageIsRenderable);
	});
}

/** The first non-empty line of a task, without Markdown heading marks, bounded for one row. */
function firstTaskLine(text: string): string {
	const line = text.split("\n").map((part) => part.replace(/^#+\s*/u, "").trim()).find((part) => part.length > 0) ?? "";
	const characters = Array.from(line);
	return characters.length > 160 ? `${characters.slice(0, 159).join("")}…` : line;
}

/**
 * Historical first input recovered from the session summary when the bounded
 * transcript dropped the oldest entries. It is not the current task or role.
 * It shows as one line; the agent's Details keep the whole text.
 */
export function firstTaskEntry(
	snapshot: { readonly entries: readonly AgentConversationEntry[]; readonly partial: boolean },
	row: { readonly firstMessage?: string } | undefined,
): AgentConversationEntry | undefined {
	if (!snapshot.partial) return undefined;
	const first = (row?.firstMessage ?? "").trim();
	if (first === "") return undefined;
	const present = snapshot.entries.some(
		(entry) =>
			isInputKind(entry.kind) && (entry.model ?? []).some((message) => contentText(message.content, false).trimStart().startsWith(first)),
	);
	if (present) return undefined;
	return {
		id: "first-task",
		kind: AGENT_INPUT_KIND,
		data: { author: { role: "unknown" } },
		model: [{ role: "user", content: `First task · ${firstTaskLine(first)}`, timestamp: 0 }],
	};
}

/**
 * The row that stands in for hidden reasoning. A message that also has text, a tool call or an error
 * shows those instead, so its hidden thinking takes no row; a thinking-only message keeps a short row,
 * which a click opens. Ctrl+T and More › Show thinking reveal every message's reasoning.
 */
function thinkingLabel(message: AssistantMessage): string {
	const visible = message.content.some((part) => (part.type === "text" && part.text.trim().length > 0) || part.type === "toolCall")
		|| message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length";
	return visible ? "" : "▸ Thinking";
}

function liveNestedTool(entry: AgentConversationEntry): NestedToolSlot | undefined {
	return entry.id.startsWith("live:") ? (entry.data as { nestedTool?: NestedToolSlot } | undefined)?.nestedTool : undefined;
}

function entryTimestamp(entry: AgentConversationEntry): number {
	for (const message of entry.model ?? [])
		if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
	return 0;
}

/** A conversation transcript uses Pi's public chat components and built-in tool presentation. */
export class AgentConversation {
	private blocks: ConversationBlock[] = [];
	private entryBlocks = new Map<string, { signature: string; blocks: ConversationBlock[] }>();
	private readonly resultKeys = new WeakMap<Component, string>();
	private readonly callCards = new Map<string, { signature: string; component: ReadingToolComponent }>();
	private readonly unmatched = new Map<string, ReadingToolComponent>();
	private readonly nestedTools = new Map<string, ReadingToolComponent>();
	private readonly assistants = new Map<string, AssistantMessageComponent>();
	private readonly rendered = new Map<Component, { width: number; lines: string[]; top: number }>();
	/** Final rows: trimmed content at the reading width, with the shared leading gap and margin. */
	private readonly rows = new Map<Component, { width: number; gap: number; lines: string[] }>();
	private signatures: string[] = [];
	private readonly definitions: ReturnType<typeof createDashboardToolDefinitions>;
	private readonly reading: Pick<AgentReadingState, "toolExpanded">;
	private readonly tools = new Map<string, ReadingToolComponent>();
	/** Agent cards read observed roster facts at paint; a roster change refreshes only these. */
	private readonly agentCards = new Set<ReadingToolComponent>();
	/** Communication cards name senders and threads from the same observed facts. */
	private readonly noticeCards = new Set<CustomMessageComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private expanded: boolean;
	private showThinking: boolean;
	private readonly renderCustom?: (entry: AgentConversationEntry) => Component | undefined;
	/** Observed names and thread titles for notices; absent values keep exact identities. */
	private readonly lookup?: AgentCardLookup;
	/** The hidden-thinking label each assistant currently carries, so a label change reaches only that message. */
	private readonly thinkingLabels = new WeakMap<AssistantMessageComponent, string>();
	constructor(
		entries: readonly AgentConversationEntry[],
		cwd: string,
		tui: TUI,
		expanded: boolean,
		showThinking: boolean,
		renderCustom?: (entry: AgentConversationEntry) => Component | undefined,
		reading?: Pick<AgentReadingState, "toolExpanded">,
		toolDisplay?: (name: string) => ToolRenderers | undefined,
		rows?: AgentCardLookup,
	) {
		this.cwd = cwd;
		this.tui = tui;
		this.expanded = expanded;
		this.showThinking = showThinking;
		this.renderCustom = renderCustom;
		this.lookup = rows;
		this.definitions = createDashboardToolDefinitions(cwd, toolDisplay, rows);
		this.reading = reading ?? { toolExpanded: new Map() };
		this.update(entries);
	}

	/** Stable entry and call identities keep measured committed blocks through prepend and eviction. */
	update(entries: readonly AgentConversationEntry[]): void {
		const signatures = entries.map((entry) => JSON.stringify(entry));
		if (
			signatures.length === this.signatures.length &&
			signatures.every((signature, index) => signature === this.signatures[index])
		)
			return;

		const next = new Map<string, { signature: string; blocks: ConversationBlock[] }>();
		this.blocks = [];
		this.tools.clear();
		entries.forEach((entry, index) => {
			const cached = this.entryBlocks.get(entry.id);
			const start = this.blocks.length;
			const result = (entry.model ?? []).some((message) => message.role === "toolResult") || liveNestedTool(entry) !== undefined;
			if (cached?.signature === signatures[index] && !result) {
				this.blocks.push(...cached.blocks);
				this.restoreEntryTools(entry);
			} else this.appendEntry(entry);
			next.set(entry.id, { signature: signatures[index], blocks: this.blocks.slice(start) });
		});
		const resultIds = new Set(entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : [])));
		for (const [id, tool] of this.tools) {
			if (!this.resultKeys.has(tool) || resultIds.has(id)) continue;
			tool.updateResult({ content: [], isError: false }, true);
			this.resultKeys.delete(tool);
			this.rendered.delete(tool);
			this.rows.delete(tool);
		}
		this.entryBlocks = next;
		this.signatures = signatures;
		this.pruneComponents();
	}
	/** Release renderer-owned timers before the transcript leaves its view. */
	dispose(): void {
		for (const [id, tool] of this.tools) {
			if (!this.nestedTools.has(id)) tool.updateResult({ content: [], isError: false });
		}
		this.update([]);
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.reading.toolExpanded.clear();
		for (const { component } of this.blocks) {
			if (component instanceof ToolExecutionComponent || component instanceof CustomMessageComponent) component.setExpanded(expanded);
		}
		this.clearLayoutCache();
	}
	/** Observed roster facts changed: agent cards repaint through their renderers with the current lookup. */
	refreshCards(): void {
		for (const component of this.agentCards) component.invalidate();
		for (const component of this.noticeCards) {
			component.invalidate();
			this.rendered.delete(component);
			this.rows.delete(component);
		}
	}
	/** A global thinking change reaches every retained native assistant and clears its per-run choices. */
	setShowThinking(show: boolean): void {
		this.showThinking = show;
		for (const component of this.assistants.values()) component.setHideThinkingBlock(!show);
		this.clearLayoutCache();
	}
	private clearLayoutCache(): void {
		this.rendered.clear();
		this.rows.clear();
	}
	private assistant(message: AssistantMessage, live: boolean): AssistantMessageComponent {
		const label = thinkingLabel(message);
		const component = new AssistantMessageComponent(undefined, !this.showThinking, getMarkdownTheme(), label);
		this.thinkingLabels.set(component, label);
		component.setOutputPad(0);
		component.updateContent(message, live);
		return component;
	}
	/** A message that gains text or a tool call drops its hidden-thinking row; Pi re-renders it once. */
	private syncThinkingLabel(component: AssistantMessageComponent, message: AssistantMessage): void {
		const label = thinkingLabel(message);
		if (this.thinkingLabels.get(component) === label) return;
		this.thinkingLabels.set(component, label);
		component.setHiddenThinkingLabel(label);
	}
	/** Move a live instance to its committed entry without replaying its private choices. */
	renameEntry(previous: string, next: string): void {
		for (const [key, component] of this.assistants) {
			if (key !== previous && !key.startsWith(`${previous}:assistant:`)) continue;
			this.assistants.delete(key);
			this.assistants.set(next + key.slice(previous.length), component);
		}
	}

	private pruneComponents(): void {
		const retained = new Set(this.blocks.map((block) => block.component));
		const caches: Array<{ keys(): Iterable<Component>; delete(component: Component): boolean }> = [this.agentCards, this.noticeCards, this.rendered, this.rows];
		for (const cache of caches) {
			for (const component of [...cache.keys()]) if (!retained.has(component)) cache.delete(component);
		}
		for (const [id, card] of this.callCards) if (!retained.has(card.component)) this.callCards.delete(id);
		for (const [id, component] of this.unmatched) if (!retained.has(component)) this.unmatched.delete(id);
		this.pruneNestedTools(retained);
		for (const [id, component] of this.assistants) if (!retained.has(component)) this.assistants.delete(id);
	}
	private pruneNestedTools(retained: Set<Component>): void {
		for (const [id, component] of this.nestedTools) {
			if (retained.has(component)) continue;
			// Release native renderer timers when the live slot disappears.
			component.updateResult({ content: [], isError: false });
			this.nestedTools.delete(id);
		}
	}
	private restoreEntryTools(entry: AgentConversationEntry): void {
		const calls = (entry.model ?? []).flatMap((message) =>
			message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
		);
		for (const part of calls) {
			const block = this.blocks.find((block) => block.id === `${entry.id}:${part.id}`);
			if (!block || !(block.component instanceof ToolExecutionComponent)) continue;

			this.tools.set(part.id, block.component as ReadingToolComponent);
		}
	}
	private matchedTool(name: string, id: string): ReadingToolComponent | undefined {
		const component = this.unmatched.get(id);
		if (!component) return;
		const fallback = this.definitions(name, false);
		const known = this.definitions(name);
		if (fallback.renderCall === known.renderCall && fallback.renderResult === known.renderResult && fallback.renderShell === known.renderShell) return component;
		// Pi has no definition setter. A newly available native renderer requires one replacement.
		this.unmatched.delete(id);
		return undefined;
	}
	private callCard(part: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): ReadingToolComponent {
		const signature = JSON.stringify(part);
		const cached = this.callCards.get(part.id);
		if (cached?.signature === signature) return cached.component;
		const retained = cached?.component ?? this.matchedTool(part.name, part.id);
		const component = retained ?? this.tool(part.name, part.id, part.arguments);
		component.argumentsError = part.argumentsError;
		if (retained) {
			component.updateArgs(part.arguments);
			this.rendered.delete(component);
			this.rows.delete(component);
		}
		this.callCards.set(part.id, { signature, component });
		return component;
	}
	/** Blocks from one entry share its step, so the transcript adds no blank row inside an entry. */
	private appendEntry(source: AgentConversationEntry): void {
		const start = this.blocks.length;
		try {
			this.appendEntryBlocks(source);
		} catch {
			this.blocks.push({ id: source.id, component: new Text("[Message unavailable: invalid stored content]", 0, 0) });
		} finally {
			for (let index = start; index < this.blocks.length; index++) this.blocks[index].step = source.id;
		}
	}
	private appendEntryBlocks(source: AgentConversationEntry): void {
		const communication = parseCommunicationView(source.communication);
		if (communication?.state === "ready") {
			this.blocks.push({ id: source.id, component: this.communicationCard(source.id, communication.value) });
			return;
		}
		if (communication?.state === "unavailable") this.blocks.push({ id: `${source.id}:communication`, component: new Text(`[Communication metadata unavailable: ${communication.reason}]`, 0, 0) });
		const entry = displayValue(source) as AgentConversationEntry;
		const nested = liveNestedTool(entry);
		if (nested) {
			this.appendNestedTool(entry.id, nested);
			return;
		}
		if (entry.kind === "pi.custom_message" && this.renderCustom) {
			const component = this.renderCustom(entry);
			if (component) {
				this.blocks.push({ id: entry.id, component });
				return;
			}
		}
		if (entry.kind === "pi.compaction") {
			this.appendCompaction(entry);
			return;
		}
		if (entry.kind === "pi.reset")
			this.blocks.push({ id: `${entry.id}:reset`, component: new Text("── New context ──", 0, 0) });
		let assistantIndex = 0;
		for (const message of entry.model ?? []) {
			if (message.role === "assistant") this.appendAssistant(entry.id, message, assistantIndex++);
			else this.appendMessage(entry.id, message);
		}
	}
	/**
	 * The structured communication reaches the Agent card as the message details; the text is a fallback
	 * only. Pointer disclosure lives in the reading state under the entry id, so it survives a rebuilt
	 * transcript and a return from another view, and a global expansion change clears it with the rest.
	 */
	private communicationCard(id: string, value: Communication): Component {
		const message = {
			role: "custom" as const,
			customType: "agent.communication",
			content: cleanDashboardText(value.body.text),
			display: true,
			details: value,
			timestamp: value.recordedAt,
		};
		const key = `communication:${id}`;
		bindCardDisclosure(message, {
			get: () => this.reading.toolExpanded.get(key),
			set: (expanded) => { this.reading.toolExpanded.set(key, expanded); },
		});
		const component = new CustomMessageComponent(message, compactCommunicationRenderer(this.lookup), getMarkdownTheme(), 0);
		component.setExpanded(this.expanded);
		this.noticeCards.add(component);
		return component;
	}
	/** Native compaction entries keep their wrapped summary text under a distinct label. */
	private appendCompaction(entry: AgentConversationEntry): void {
		const text = (entry.model ?? [])
			.map((message) => contentText(message.content))
			.join("\n")
			.trim();
		const message = {
			role: "custom" as const,
			customType: "compaction",
			content: text || "Compaction summary text is unavailable",
			display: true,
			timestamp: entryTimestamp(entry),
		};
		const component = new CustomMessageComponent(message, undefined, getMarkdownTheme(), 0);
		component.setExpanded(this.expanded);
		this.blocks.push({ id: entry.id, component });
	}
	private tool(name: string, id: string, args: unknown, known = true): ReadingToolComponent {
		const definition = this.definitions(name, known);
		const tool = new ReadingToolComponent(name, id, args, { showImages: false }, definition, this.tui, this.cwd);
		tool.onInvalidate = () => { this.rendered.delete(tool); this.rows.delete(tool); };
		if (agentCardNames.has(name)) this.agentCards.add(tool);
		tool.setExpanded(this.reading.toolExpanded.get(id) ?? this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage, assistantIndex = 0): void {
		const key = assistantIndex === 0 ? id : `${id}:assistant:${assistantIndex}`;
		let component = this.assistants.get(key);
		if (!component) {
			component = this.assistant(message, id.startsWith("live:"));
			this.assistants.set(key, component);
		} else {
			component.updateContent(message, id.startsWith("live:"));
			this.syncThinkingLabel(component, message);
		}
		this.rendered.delete(component);
		this.rows.delete(component);
		this.blocks.push({ id: key, component });
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const tool = this.callCard(part);
			if (!id.startsWith("live:")) tool.setArgsComplete();
			if (message.stopReason === "error" || message.stopReason === "aborted")
				tool.updateResult({
					content: [
						{
							type: "text",
							text:
								message.errorMessage || (message.stopReason === "aborted" ? "Operation stopped" : "Operation failed"),
						},
					],
					isError: true,
				});
			this.tools.set(part.id, tool);
			this.blocks.push({ id: `${id}:${part.id}`, component: tool });
		}
	}

	/** Native nested slots are live presentation, not model-issued transcript messages. */
	private appendNestedTool(id: string, slot: NestedToolSlot): void {
		let tool = this.nestedTools.get(slot.callId);
		if (!tool) {
			tool = this.tool(slot.name, slot.callId, slot.arguments);
			this.nestedTools.set(slot.callId, tool);
		}
		tool.updateArgs(slot.arguments);
		tool.setArgsComplete();
		if (slot.status !== "pending") tool.markExecutionStarted();
		const status = slot.status !== "done" ? slot.status : slot.summary ? slot.summary.isError ? "error" : "ok" : "done (result unavailable)";
		const duration = slot.summary?.durationMs === undefined ? "" : ` ${slot.summary.durationMs}ms`;
		this.blocks.push({ id: `${id}:parent`, component: new Text(`Nested tool ${slot.callId} under ${slot.parentCallId}: ${status}${duration}`, 0, 0) });
		tool.updateResult({
			content: slot.output ? [{ type: "text", text: slot.output }] : slot.summary?.error ? [{ type: "text", text: slot.summary.error }] : [],
			details: slot.details,
			isError: slot.summary?.isError ?? false,
			...(slot.summary?.durationMs === undefined ? {} : { durationMs: slot.summary.durationMs }),
		}, slot.status !== "done");
		this.tools.set(slot.callId, tool);
		this.blocks.push({ id, component: tool });
		this.rendered.delete(tool);
		this.rows.delete(tool);
	}

	private appendResult(id: string, message: ToolResultMessage, partial = false): void {
		let tool = this.tools.get(message.toolCallId);
		if (!tool) {
			tool =
				this.callCards.get(message.toolCallId)?.component ?? this.unmatched.get(message.toolCallId) ?? this.tool(message.toolName, message.toolCallId, undefined, false);
			this.unmatched.set(message.toolCallId, tool);
			this.tools.set(message.toolCallId, tool);
			this.blocks.push({ id, component: tool });
		}
		const signature = JSON.stringify([message, partial]);
		if (this.resultKeys.get(tool) === signature) return;
		tool.markExecutionStarted();
		tool.updateResult(message, partial);
		this.resultKeys.set(tool, signature);
		this.rendered.delete(tool);
		this.rows.delete(tool);
	}
	private appendMessage(id: string, message: Message): void {
		const markdown = getMarkdownTheme();
		let component: Component | undefined;
		switch (message.role) {
			case "assistant":
				this.appendAssistant(id, message);
				return;
			case "toolResult":
				this.appendResult(id, message, id.startsWith("live:"));
				return;
			case "user":
				// Host routes live in structured request context; routing-looking user text stays user text.
				{
					const user = new UserMessageComponent(contentText(message.content), markdown);
					user.setOutputPad(0);
					component = user;
				}
				break;
			case "system": {
				const text = contentText(message.content).trim();
				if (text) component = new Text(text, 0, 0);
				break;
			}
		}
		if (component) this.blocks.push({ id, component });
	}

	private readingWidth(width: number): { margin: number; textWidth: number } {
		// The dashboard passes its pane width minus the scrollbar column; the helper expects the pane.
		return readingGeometry(width + 1);
	}
	/**
	 * The width one block renders at: prose and agent cards keep the readable column; other tool lines
	 * and their output use the pane, as in the main session, so commands and paths show before they shorten.
	 */
	private componentWidth(component: Component, width: number): { margin: number; textWidth: number } {
		const reading = this.readingWidth(width);
		const wide = component instanceof ReadingToolComponent && !this.agentCards.has(component);
		return wide ? { margin: reading.margin, textWidth: Math.max(reading.textWidth, width - reading.margin) } : reading;
	}
	/** Trimmed component rows at the block's width. The margin and the shared gap are added in `blockRows`. */
	private blockLines(component: Component, width: number): string[] {
		const cached = this.rendered.get(component);
		if (cached?.width === width) return cached.lines;
		const { margin, textWidth } = this.componentWidth(component, width);
		let trimmed: { lines: string[]; top: number };
		try {
			trimmed = trimBlankRows(component.render(textWidth));
		} catch {
			trimmed = { lines: ["[Message unavailable: renderer rejected stored content]"], top: 0 };
		}
		const pad = " ".repeat(margin);
		const lines = trimmed.lines.map((line) => pad + fitText(line, textWidth));
		this.rendered.set(component, { width, lines, top: trimmed.top });
		return lines;
	}
	/** Final rows: one shared blank row before every new step, never two. */
	private blockRows(component: Component, width: number, gap: number): string[] {
		const content = this.blockLines(component, width);
		if (!content.length) return content;
		const cached = this.rows.get(component);
		if (cached?.width === width && cached.gap === gap) return cached.lines;
		const lines = gap ? ["", ...content] : content;
		this.rows.set(component, { width, gap, lines });
		return lines;
	}
	private contentHeight(component: Component, width: number): number {
		const cached = this.rendered.get(component);
		return cached?.width === width ? cached.lines.length : 3;
	}
	/** A collapsed tool drawn as its one summary line. */
	private compactTool(component: Component, width: number): boolean {
		return component instanceof ReadingToolComponent && this.contentHeight(component, width) === 1;
	}
	/**
	 * One blank row between steps; blocks from one entry and its tool calls share a step. Consecutive
	 * one-line tool steps read as one run of activity, so no blank row separates them; commentary, notices
	 * and open cards keep their gap.
	 */
	private blockGap(index: number, width: number): number {
		const current = this.blocks[index];
		if (this.contentHeight(current.component, width) === 0) return 0;
		for (let previous = index - 1; previous >= 0; previous--) {
			const block = this.blocks[previous];
			if (this.contentHeight(block.component, width) === 0) continue;
			if (block.step === current.step) return 0;
			return this.compactTool(block.component, width) && this.compactTool(current.component, width) ? 0 : 1;
		}
		return 0;
	}
	private blockHeight(index: number, width: number): number {
		const component = this.blocks[index].component;
		const gap = this.blockGap(index, width);
		const content = this.rendered.get(component);
		if (content?.width === width) return content.lines.length ? content.lines.length + gap : 0;
		return 3 + gap;
	}
	private layout(width: number): { anchors: ConversationDocument["anchors"]; height: number } {
		let height = 0;
		const anchors = this.blocks.map(({ id }, index) => {
			const anchor = { id, line: height };
			height += this.blockHeight(index, width);
			return anchor;
		});
		return { anchors, height };
	}
	private measureWindow(width: number, top: number, height: number, anchors: ConversationDocument["anchors"]): void {
		const nearStart = Math.max(0, top - 2 * height);
		const nearEnd = top + 3 * height;
		this.blocks.forEach(({ component }, index) => {
			const start = anchors[index].line;
			const end = anchors[index + 1]?.line ?? Number.MAX_SAFE_INTEGER;
			if (end >= nearStart && start <= nearEnd) this.blockLines(component, width);
		});
	}
	private anchorTop(width: number, anchors: ConversationDocument["anchors"], anchor: AgentReadingState["anchor"], requested: number): number {
		const entry = anchor ? anchors.find((item) => item.id === anchor.id) : undefined;
		if (!entry || !anchor) return requested;
		const index = this.blocks.findIndex((block) => block.id === entry.id);
		if (index < 0) return requested;
		this.blockLines(this.blocks[index].component, width);
		const blockHeight = this.blockHeight(index, width);
		const offset = Math.min(anchor.offset, Math.max(0, blockHeight - 1));
		return entry.line + offset;
	}
	/** Height estimates for unseen blocks are replaced only near the reading viewport. */
	renderWindow(
		width: number,
		requested: number,
		height: number,
		follow: boolean,
		anchor?: AgentReadingState["anchor"],
	): { lines: string[]; anchors: ConversationDocument["anchors"]; height: number; top: number; estimated: boolean } {
		let layout = this.layout(width);
		let top = requested;
		for (let pass = 0; pass <= this.blocks.length; pass++) {
			top = follow ? Math.max(0, layout.height - height) : this.anchorTop(width, layout.anchors, anchor, requested);
			top = Math.max(0, Math.min(top, Math.max(0, layout.height - height)));
			this.measureWindow(width, top, height, layout.anchors);
			const next = this.layout(width);
			if (
				next.height === layout.height &&
				next.anchors.every((item, index) => item.line === layout.anchors[index]?.line)
			) {
				layout = next;
				break;
			}
			layout = next;
		}
		const lines = Array.from({ length: height }, () => "");
		this.blocks.forEach(({ component }, index) => {
			const start = layout.anchors[index].line;
			const measured = this.rendered.get(component);
			if (measured?.width !== width) return;
			const rows = this.blockRows(component, width, this.blockGap(index, width));
			if (start + rows.length <= top || start >= top + height) return;
			for (let line = Math.max(0, top - start); line < rows.length && start + line < top + height; line++)
				lines[start + line - top] = rows[line];
		});
		this.blocks.forEach(({ component }, index) => {
			const line = layout.anchors[index].line;
			const end = layout.anchors[index + 1]?.line ?? Number.MAX_SAFE_INTEGER;
			if (end < top - 2 * height || line > top + 3 * height) {
				this.rendered.delete(component);
				this.rows.delete(component);
			}
		});
		const estimated = this.blocks.some(({ component }) => this.rendered.get(component)?.width !== width);
		return { lines, ...layout, top, estimated };
	}
	render(width: number): ConversationDocument {
		const document: ConversationDocument = { lines: [], anchors: [] };
		// Gaps depend on measured neighbours, so every block is measured before any gap is chosen.
		for (const { component } of this.blocks) this.blockLines(component, width);
		this.blocks.forEach(({ id, component }, index) => {
			const lines = this.blockRows(component, width, this.blockGap(index, width));
			if (!lines.length) return;
			document.anchors.push({ id, line: document.lines.length });
			document.lines.push(...lines);
		});
		return document;
	}
	private toolClick(component: ReadingToolComponent, event: TuiMouseEvent): boolean {
		const call = [...this.tools].find(([, tool]) => tool === component)?.[0];
		if (!call) return false;
		const before = component.choice;
		if (!component.handleMouse(event)?.handled) component.setExpanded(!component.choice);
		if (component.choice !== before) this.reading.toolExpanded.set(call, component.choice);
		return true;
	}
	/** The item a measured block reports for one local click, in document coordinates. */
	private itemFor(component: Component, event: TuiMouseEvent, id: string, line: number, top: number): { id: string; line: number; targetOffset?: number } | undefined {
		if (component instanceof ReadingToolComponent) return this.toolClick(component, event) ? { id, line } : undefined;
		if (component instanceof AssistantMessageComponent) {
			const dispatched = component.handleMouse(event);
			if (!dispatched?.handled) return undefined;
			return { id, line, targetOffset: dispatched.target.originY - (event.screenY - event.y) - top };
		}
		if (component instanceof CustomMessageComponent) return component.handleMouse(event)?.handled ? { id, line } : undefined;
		return undefined;
	}
	/** Only measured blocks receive clicks; the shared gap row belongs to no block. */
	handleMouse(event: TuiMouseEvent): { id: string; line: number; targetOffset?: number } | undefined {
		if (!isItemClick(event)) return;
		const layout = this.layout(event.width);
		const index = layout.anchors.findIndex((anchor, index) => {
			const measured = this.rendered.get(this.blocks[index].component);
			return measured?.width === event.width && event.y >= anchor.line && event.y < anchor.line + this.blockHeight(index, event.width);
		});
		if (index < 0) return;
		const { id, component } = this.blocks[index];
		const line = layout.anchors[index].line;
		const measured = this.rendered.get(component);
		if (!measured) return;
		const gap = this.blockGap(index, event.width);
		const localY = event.y - line - gap;
		if (localY < 0) return;
		const { margin, textWidth } = this.componentWidth(component, event.width);
		const local = { ...event, x: event.x - margin, y: localY + measured.top, width: textWidth, height: measured.lines.length + measured.top };
		if (local.x < 0) return;
		const item = this.itemFor(component, local, id, line, measured.top);
		if (!item) return;
		this.rendered.delete(component);
		this.rows.delete(component);
		this.tui.requestRender();
		return item;
	}
	invalidate(): void {
		this.clearLayoutCache();
		for (const block of this.blocks) block.component.invalidate();
	}
}
