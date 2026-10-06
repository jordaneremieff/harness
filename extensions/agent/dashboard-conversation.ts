import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { createDashboardToolDefinitions, normalizeCodemodeDetails } from "./dashboard-tool-definitions.ts";
import type { AgentReadingState } from "./dashboard-state.ts";
import { awaitFactLines, type AwaitFact } from "./await-facts.ts";

export function cleanDashboardText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

/** Native renderers receive display data only, never executable extension renderers or image payloads. */
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
/** Public container composition identifies nonempty thinking runs in source order. */
export function thinkingRegions(component: Component): MouseRegion[] {
	if (component instanceof MouseRegion) return [component];
	return component instanceof Container ? component.children.flatMap(thinkingRegions) : [];
}
function regionLayout(component: Component, width: number, top = 0): Array<{ region: MouseRegion; line: number; height: number }> {
	if (component instanceof MouseRegion) return [{ region: component, line: top, height: component.render(width).length }];
	if (!(component instanceof Container)) return [];
	const regions: ReturnType<typeof regionLayout> = [];
	for (const child of component.children) {
		regions.push(...regionLayout(child, width, top));
		top += child.render(width).length;
	}
	return regions;
}
function isItemClick(event: TuiMouseEvent): boolean {
	return event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl && (event.clickCount ?? 1) === 1;
}
const replayClick: TuiMouseEvent = { type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 1, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1 };

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
	private resultCalls = new Set<string>();
	private readonly callCards = new Map<string, { signature: string; component: ToolExecutionComponent }>();
	private readonly unmatched = new Map<string, ToolExecutionComponent>();
	private readonly rendered = new Map<Component, { width: number; lines: string[] }>();
	private signatures: string[] = [];
	private readonly heights = new Map<Component, { width: number; height: number }>();
	private cache?: { width: number; document: ConversationDocument };
	private readonly definitions: ReturnType<typeof createDashboardToolDefinitions>;
	private readonly reading: Pick<AgentReadingState, "toolExpanded" | "thinkingVisible">;
	private readonly assistantRuns = new WeakMap<Component, { keys: string[] }>();
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private readonly expanded: boolean;
	private readonly showThinking: boolean;
	private awaitingSignature = "";
	private readonly renderCustom?: (entry: AgentConversationEntry) => Component | undefined;
	constructor(
		entries: readonly AgentConversationEntry[],
		cwd: string,
		tui: TUI,
		expanded: boolean,
		showThinking: boolean,
		renderCustom?: (entry: AgentConversationEntry) => Component | undefined,
		reading?: Pick<AgentReadingState, "toolExpanded" | "thinkingVisible">,
	) {
		this.cwd = cwd;
		this.tui = tui;
		this.expanded = expanded;
		this.showThinking = showThinking;
		this.renderCustom = renderCustom;
		this.definitions = createDashboardToolDefinitions(cwd);
		this.reading = reading ?? { toolExpanded: new Map(), thinkingVisible: new Map() };
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
		this.resultCalls = new Set(
			entries.flatMap((entry) =>
				(entry.model ?? []).flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
			),
		);
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
		this.entryBlocks = next;
		this.signatures = signatures;
		this.cache = undefined;
		this.pruneComponents();
	}
	/** Current dependency facts share the selected pane's scroll, not retained history. */
	setAwaiting(fact?: AwaitFact): void {
		const id = "current-await-facts";
		const signature = JSON.stringify(fact) ?? "";
		if (signature === this.awaitingSignature && this.blocks.some((block) => block.id === id) === (fact !== undefined)) return;
		this.blocks = this.blocks.filter((block) => block.id !== id);
		if (fact !== undefined) this.blocks.push({ id, component: new Text(awaitFactLines(fact).map(cleanDashboardText).join("\n"), 1, 1) });
		this.awaitingSignature = signature;
		this.cache = undefined;
		this.pruneComponents();
	}
	private pruneComponents(): void {
		const retained = new Set(this.blocks.map((block) => block.component));
		for (const component of this.rendered.keys()) if (!retained.has(component)) this.rendered.delete(component);
		for (const component of this.heights.keys()) if (!retained.has(component)) this.heights.delete(component);
		for (const [id, card] of this.callCards) if (!retained.has(card.component)) this.callCards.delete(id);
		for (const [id, component] of this.unmatched) if (!retained.has(component)) this.unmatched.delete(id);
	}
	private restoreEntryTools(entry: AgentConversationEntry): void {
		const calls = (entry.model ?? []).flatMap((message) =>
			message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
		);
		for (const part of calls) {
			const block = this.blocks.find((block) => block.id === `${entry.id}:${part.id}`);
			if (!block || !(block.component instanceof ToolExecutionComponent)) continue;
			if (this.resultKeys.has(block.component) && !this.resultCalls.has(part.id)) {
				block.component = this.tool(part.name, part.id, part.arguments);
				this.callCards.set(part.id, {
					signature: JSON.stringify(part),
					component: block.component as ToolExecutionComponent,
				});
			}
			this.tools.set(part.id, block.component as ToolExecutionComponent);
		}
	}
	private callCard(part: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): ToolExecutionComponent {
		const signature = JSON.stringify(part);
		const cached = this.callCards.get(part.id);
		if (cached?.signature === signature) return cached.component;
		const component = this.tool(part.name, part.id, part.arguments);
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
			let runStart = 0;
			let assistantIndex = 0;
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") runStart += this.appendAssistant(entry.id, message, runStart, assistantIndex++);
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
	private tool(name: string, id: string, args: unknown, known = true): ToolExecutionComponent {
		const definition = this.definitions(name, known);
		// An absent call or empty arguments need no argument object in the display.
		const shown =
			args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0
				? undefined
				: displayValue(args);
		let tool: ToolExecutionComponent;
		const displayTui = Object.create(this.tui) as TUI;
		displayTui.requestRender = () => {
			this.rendered.delete(tool);
			this.heights.delete(tool);
			this.cache = undefined;
			this.tui.requestRender();
		};
		tool = new ToolExecutionComponent(name, id, shown, { showImages: false }, definition, displayTui, this.cwd);
		tool.setExpanded(this.reading.toolExpanded.get(id) ?? this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage, runStart = 0, assistantIndex = 0): number {
		const component = new AssistantMessageComponent(message, !this.showThinking, getMarkdownTheme(), "Thinking...");
		const keys = thinkingRegions(component).map((_, index) => JSON.stringify([id, runStart + index]));
		keys.forEach((key, index) => {
			if ((this.reading.thinkingVisible.get(key) ?? this.showThinking) !== this.showThinking)
				thinkingRegions(component)[index]?.handleMouse(replayClick);
		});
		this.assistantRuns.set(component, { keys });
		this.blocks.push({ id: assistantIndex === 0 ? id : `${id}:assistant:${assistantIndex}`, component });
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
		return keys.length;
	}

	private appendResult(id: string, message: ToolResultMessage, partial = false): void {
		let tool = this.tools.get(message.toolCallId);
		if (!tool) {
			tool =
				this.unmatched.get(message.toolCallId) ?? this.tool(message.toolName, message.toolCallId, undefined, false);
			this.unmatched.set(message.toolCallId, tool);
			this.tools.set(message.toolCallId, tool);
			this.blocks.push({ id, component: tool });
		}
		const signature = JSON.stringify([message, partial]);
		if (this.resultKeys.get(tool) === signature) return;
		tool.markExecutionStarted();
		tool.updateResult(message.toolName === "codemode" ? { ...message, details: normalizeCodemodeDetails(message.details, message.toolCallId) } : message, partial);
		this.resultKeys.set(tool, signature);
		this.rendered.delete(tool);
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
		const run = anchor.run === undefined ? undefined : regionLayout(block.component, width)[anchor.run];
		const blockHeight = this.heights.get(block.component)?.height ?? 1;
		const offset = Math.min(anchor.offset, Math.max(0, (run?.height ?? blockHeight) - 1));
		return entry.line + (run?.line ?? 0) + offset;
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
		if (this.cache?.width === width) return this.cache.document;
		const document: ConversationDocument = { lines: [], anchors: [] };
		for (const { id, component } of this.blocks) {
			const lines = this.blockLines(component, width);
			if (!lines.length) continue;
			document.anchors.push({ id, line: document.lines.length });
			document.lines.push(...lines);
		}
		this.cache = { width, document };
		return document;
	}
	/** Only measured blocks receive clicks; pending cards include their background padding. */
	handleMouse(event: TuiMouseEvent): { id: string; line: number; run?: number } | undefined {
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
		let item: { id: string; line: number; run?: number } | undefined;
		if (component instanceof ToolExecutionComponent) {
			if (local.y === 0) return;
			const call = [...this.tools].find(([, tool]) => tool === component)?.[0];
			if (!call) return;
			const next = !(this.reading.toolExpanded.get(call) ?? this.expanded);
			component.handleMouse?.(local);
			component.setExpanded(next);
			this.reading.toolExpanded.set(call, next);
			item = { id, line };
		} else if (component instanceof AssistantMessageComponent) {
			const regions = regionLayout(component, event.width);
			const result = component.handleMouse(local);
			const run = regions.findIndex((region) => region.region === result?.target.component);
			const key = this.assistantRuns.get(component)?.keys[run];
			if (run < 0 || !key || !result?.handled) return;
			this.reading.thinkingVisible.set(key, !(this.reading.thinkingVisible.get(key) ?? this.showThinking));
			item = { id, line: line + regions[run].line, run };
		}
		if (!item) return;
		this.rendered.delete(component);
		this.heights.delete(component);
		this.cache = undefined;
		this.tui.requestRender();
		return item;
	}
	invalidate(): void {
		this.rendered.clear();
		this.heights.clear();
		this.cache = undefined;
		for (const block of this.blocks) block.component.invalidate();
	}
}
