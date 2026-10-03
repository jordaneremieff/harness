import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";

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
const nativeTools = (cwd: string) => [
	createReadToolDefinition(cwd),
	createBashToolDefinition(cwd),
	createEditToolDefinition(cwd),
	createWriteToolDefinition(cwd),
	createGrepToolDefinition(cwd),
	createFindToolDefinition(cwd),
	createLsToolDefinition(cwd),
	createPowerShellToolDefinition(cwd),
];

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
	private readonly definitions: ReturnType<typeof nativeTools>;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private readonly expanded: boolean;
	private readonly showThinking: boolean;
	private readonly renderCustom?: (entry: AgentConversationEntry) => Component | undefined;
	constructor(
		entries: readonly AgentConversationEntry[],
		cwd: string,
		tui: TUI,
		expanded: boolean,
		showThinking: boolean,
		renderCustom?: (entry: AgentConversationEntry) => Component | undefined,
	) {
		this.cwd = cwd;
		this.tui = tui;
		this.expanded = expanded;
		this.showThinking = showThinking;
		this.renderCustom = renderCustom;
		this.definitions = nativeTools(cwd);
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
			for (const message of entry.model ?? []) this.appendMessage(entry.id, message);
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
		const definition = known ? this.definitions.find((item) => item.name === name) : undefined;
		// Pi's generic card prints a JSON object; an empty one renders as a bare `{}`.
		const shown =
			args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0
				? undefined
				: args;
		const tool = new ToolExecutionComponent(name, id, shown, { showImages: false }, definition, this.tui, this.cwd);
		tool.setExpanded(this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage): void {
		this.blocks.push({
			id,
			component: new AssistantMessageComponent(message, !this.showThinking, getMarkdownTheme(), "Thinking..."),
		});
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const tool = this.callCard(part);
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
				this.unmatched.get(message.toolCallId) ?? this.tool(message.toolName, message.toolCallId, undefined, false);
			this.unmatched.set(message.toolCallId, tool);
			this.tools.set(message.toolCallId, tool);
			this.blocks.push({ id, component: tool });
		}
		const signature = JSON.stringify([message, partial]);
		if (this.resultKeys.get(tool) === signature) return;
		tool.updateResult(message, partial);
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
		const first = lines.findIndex((line) => cleanDashboardText(line).trim() !== "");
		let last = lines.length - 1;
		while (last > first && cleanDashboardText(lines[last] ?? "").trim() === "") last--;
		lines = first < 0 ? [] : lines.slice(first, last + 1);
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
			if (count) height += count + 1;
			return anchor;
		});
		return { anchors, height: Math.max(0, height - 1) };
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
	/** Height estimates for unseen blocks are replaced only near the reading viewport. */
	renderWindow(
		width: number,
		requested: number,
		height: number,
		follow: boolean,
		anchor?: { id: string; offset: number },
	): { lines: string[]; anchors: ConversationDocument["anchors"]; height: number; top: number; estimated: boolean } {
		let layout = this.layout(width);
		let top = requested;
		for (let pass = 0; pass <= this.blocks.length; pass++) {
			const entry = anchor ? layout.anchors.find((item) => item.id === anchor.id) : undefined;
			top = follow ? Math.max(0, layout.height - height) : entry ? entry.line + (anchor?.offset ?? 0) : requested;
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
			if (document.lines.length) document.lines.push("");
			document.anchors.push({ id, line: document.lines.length });
			document.lines.push(...lines);
		}
		this.cache = { width, document };
		return document;
	}
	invalidate(): void {
		this.rendered.clear();
		this.heights.clear();
		this.cache = undefined;
		for (const block of this.blocks) block.component.invalidate();
	}
}
