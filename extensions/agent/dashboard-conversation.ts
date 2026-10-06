import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import type { AgentReadingState } from "./dashboard-state.ts";
import { awaitFactLines, type AwaitFact } from "./await-facts.ts";

export function cleanDashboardText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
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
}
export interface ConversationDocument {
	lines: string[];
	anchors: Array<{ id: string; line: number }>;
}
/** Pi has no expansion getter; observe its public setter without replacing native click behavior. */
class ReadingToolComponent extends ToolExecutionComponent {
	choice = false;
	onInvalidate?: () => void;
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

/**
 * Historical first input recovered from the session summary when the bounded
 * transcript dropped the oldest entries. It is not the current task or role.
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
			entry.kind === "pi.user" && (entry.model ?? []).some((message) => contentText(message.content, false).trimStart().startsWith(first)),
	);
	if (present) return undefined;
	return {
		id: "first-task",
		kind: "pi.user",
		model: [{ role: "user", content: `Historical first input:\n${row?.firstMessage ?? first}`, timestamp: 0 }],
	};
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
	private readonly assistants = new Map<string, AssistantMessageComponent>();
	private readonly rendered = new Map<Component, { width: number; lines: string[] }>();
	private signatures: string[] = [];
	private readonly heights = new Map<Component, { width: number; height: number }>();
	private readonly definitions: ReturnType<typeof createDashboardToolDefinitions>;
	private readonly reading: Pick<AgentReadingState, "toolExpanded">;
	private readonly tools = new Map<string, ReadingToolComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private expanded: boolean;
	private showThinking: boolean;
	private awaitingSignature = "";
	private readonly renderCustom?: (entry: AgentConversationEntry) => Component | undefined;
	constructor(
		entries: readonly AgentConversationEntry[],
		cwd: string,
		tui: TUI,
		expanded: boolean,
		showThinking: boolean,
		renderCustom?: (entry: AgentConversationEntry) => Component | undefined,
		reading?: Pick<AgentReadingState, "toolExpanded">,
		toolDisplay?: (name: string) => ToolRenderers | undefined,
	) {
		this.cwd = cwd;
		this.tui = tui;
		this.expanded = expanded;
		this.showThinking = showThinking;
		this.renderCustom = renderCustom;
		this.definitions = createDashboardToolDefinitions(cwd, toolDisplay);
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
			const result = (entry.model ?? []).some((message) => message.role === "toolResult");
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
			this.heights.delete(tool);
		}
		this.entryBlocks = next;
		this.signatures = signatures;
		this.pruneComponents();
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.reading.toolExpanded.clear();
		for (const { component } of this.blocks) {
			if (component instanceof ToolExecutionComponent || component instanceof CustomMessageComponent) component.setExpanded(expanded);
		}
		this.rendered.clear();
		this.heights.clear();
	}
	setShowThinking(show: boolean): void {
		this.showThinking = show;
		for (const component of this.assistants.values()) component.setHideThinkingBlock(!show);
		this.rendered.clear();
		this.heights.clear();
	}
	/** Move a live instance to its committed entry without replaying its private choices. */
	renameEntry(previous: string, next: string): void {
		for (const [key, component] of this.assistants) {
			if (key !== previous && !key.startsWith(`${previous}:assistant:`)) continue;
			this.assistants.delete(key);
			this.assistants.set(next + key.slice(previous.length), component);
		}
	}

	/** Current dependency facts share the selected pane's scroll, not retained history. */
	setAwaiting(fact?: AwaitFact): void {
		const id = "current-await-facts";
		const signature = JSON.stringify(fact) ?? "";
		if (signature === this.awaitingSignature && this.blocks.some((block) => block.id === id) === (fact !== undefined)) return;
		this.blocks = this.blocks.filter((block) => block.id !== id);
		if (fact !== undefined) this.blocks.push({ id, component: new Text(awaitFactLines(fact).map(cleanDashboardText).join("\n"), 1, 1) });
		this.awaitingSignature = signature;
		this.pruneComponents();
	}
	private pruneComponents(): void {
		const retained = new Set(this.blocks.map((block) => block.component));
		for (const component of this.rendered.keys()) if (!retained.has(component)) this.rendered.delete(component);
		for (const component of this.heights.keys()) if (!retained.has(component)) this.heights.delete(component);
		for (const [id, card] of this.callCards) if (!retained.has(card.component)) this.callCards.delete(id);
		for (const [id, component] of this.unmatched) if (!retained.has(component)) this.unmatched.delete(id);
		for (const [id, component] of this.assistants) if (!retained.has(component)) this.assistants.delete(id);
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
	private callCard(part: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): ReadingToolComponent {
		const signature = JSON.stringify(part);
		const cached = this.callCards.get(part.id);
		if (cached?.signature === signature) return cached.component;
		const component = cached?.component ?? this.unmatched.get(part.id) ?? this.tool(part.name, part.id, part.arguments);
		if (cached || this.unmatched.has(part.id)) {
			component.updateArgs(part.arguments);
			this.rendered.delete(component);
			this.heights.delete(component);
		}
		this.callCards.set(part.id, { signature, component });
		return component;
	}
	private appendEntry(source: AgentConversationEntry): void {
		try {
			const entry = displayValue(source) as AgentConversationEntry;
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
				this.blocks.push({ id: `${entry.id}:reset`, component: new Text("── New context ──", 1, 1) });
			let assistantIndex = 0;
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") this.appendAssistant(entry.id, message, assistantIndex++);
				else this.appendMessage(entry.id, message);
			}
		} catch {
			this.blocks.push({ id: source.id, component: new Text("[Message unavailable: invalid stored content]", 1, 1) });
		}
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
		const component = new CustomMessageComponent(message, undefined, getMarkdownTheme());
		component.setExpanded(this.expanded);
		this.blocks.push({ id: entry.id, component });
	}
	private tool(name: string, id: string, args: unknown, known = true): ReadingToolComponent {
		const definition = this.definitions(name, known);
		const tool = new ReadingToolComponent(name, id, args, { showImages: false }, definition, this.tui, this.cwd);
		tool.onInvalidate = () => { this.rendered.delete(tool); this.heights.delete(tool); };
		tool.setExpanded(this.reading.toolExpanded.get(id) ?? this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage, assistantIndex = 0): void {
		const key = assistantIndex === 0 ? id : `${id}:assistant:${assistantIndex}`;
		let component = this.assistants.get(key);
		if (!component) {
			component = new AssistantMessageComponent(undefined, !this.showThinking, getMarkdownTheme(), "Thinking...");
			this.assistants.set(key, component);
		}
		component.updateContent(message, id.startsWith("live:"));
		this.rendered.delete(component);
		this.heights.delete(component);
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
		this.heights.delete(tool);
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
				component = new UserMessageComponent(contentText(message.content), markdown);
				break;
			case "system": {
				const text = contentText(message.content).trim();
				if (text) component = new Text(text, 1, 1);
				break;
			}
		}
		if (component) this.blocks.push({ id, component });
	}

	private blockLines(component: Component, width: number): string[] {
		const cached = this.rendered.get(component);
		if (cached?.width === width) return cached.lines;
		let lines: string[];
		try {
			lines = component.render(width);
		} catch {
			lines = ["[Message unavailable: renderer rejected stored content]"];
		}
		this.rendered.set(component, { width, lines });
		this.heights.set(component, { width, height: lines.length });
		return lines;
	}
	private layout(width: number): { anchors: ConversationDocument["anchors"]; height: number } {
		let height = 0;
		const anchors = this.blocks.map(({ id, component }) => {
			const cached = this.heights.get(component);
			const count = cached?.width === width ? cached.height : 3;
			const anchor = { id, line: height };
			height += count;
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
		const block = this.blocks.find((block) => block.id === entry.id);
		if (!block) return requested;
		this.blockLines(block.component, width);
		const blockHeight = this.heights.get(block.component)?.height ?? 1;
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
			const cached = this.rendered.get(component);
			if (cached?.width !== width) return;
			if (start + cached.lines.length <= top || start >= top + height) return;
			for (let line = Math.max(0, top - start); line < cached.lines.length && start + line < top + height; line++)
				lines[start + line - top] = cached.lines[line];
		});
		this.blocks.forEach(({ component }, index) => {
			const line = layout.anchors[index].line;
			const end = layout.anchors[index + 1]?.line ?? Number.MAX_SAFE_INTEGER;
			if (end < top - 2 * height || line > top + 3 * height) this.rendered.delete(component);
		});
		const estimated = this.blocks.some(({ component }) => this.heights.get(component)?.width !== width);
		return { lines, ...layout, top, estimated };
	}
	render(width: number): ConversationDocument {
		const document: ConversationDocument = { lines: [], anchors: [] };
		for (const { id, component } of this.blocks) {
			const lines = this.blockLines(component, width);
			if (!lines.length) continue;
			document.anchors.push({ id, line: document.lines.length });
			document.lines.push(...lines);
		}
		return document;
	}
	private toolClick(component: ReadingToolComponent, event: TuiMouseEvent, lines: string[]): boolean {
		const call = [...this.tools].find(([, tool]) => tool === component)?.[0];
		if (!call) return false;
		const before = component.choice;
		if (!component.handleMouse(event)?.handled) {
			// Pi leaves pending cards and box padding unhandled. Empty spacer rows stay outside the card.
			if (!lines[event.y]) return false;
			component.setExpanded(!component.choice);
		}
		if (component.choice !== before) this.reading.toolExpanded.set(call, component.choice);
		return true;
	}
	/** Only measured blocks receive clicks; pending cards include their background padding. */
	handleMouse(event: TuiMouseEvent): { id: string; line: number } | undefined {
		if (!isItemClick(event)) return;
		const layout = this.layout(event.width);
		const index = layout.anchors.findIndex((anchor, index) => {
			const measured = this.rendered.get(this.blocks[index].component);
			return measured?.width === event.width && event.y >= anchor.line && event.y < anchor.line + measured.lines.length;
		});
		if (index < 0) return;
		const { id, component } = this.blocks[index];
		const line = layout.anchors[index].line;
		const measured = this.rendered.get(component);
		if (!measured) return;
		const local = { ...event, y: event.y - line, height: measured.lines.length };
		let item: { id: string; line: number } | undefined;
		if (component instanceof ReadingToolComponent) {
			if (!this.toolClick(component, local, measured.lines)) return;
			item = { id, line };
		} else if (component instanceof AssistantMessageComponent) {
			if (!component.handleMouse(local)?.handled) return;
			item = { id, line };
		}
		if (!item) return;
		this.rendered.delete(component);
		this.heights.delete(component);
		this.tui.requestRender();
		return item;
	}
	invalidate(): void {
		this.rendered.clear();
		this.heights.clear();
		for (const block of this.blocks) block.component.invalidate();
	}
}
