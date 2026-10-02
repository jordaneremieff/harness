import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent,
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";

export function cleanDashboardText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" || char === "\t" ? char : "");
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
	if ("type" in value && value.type === "thinking" && "redacted" in value && value.redacted) return { type: "text", text: "[Redacted thinking]" };
	return Object.fromEntries(Object.entries(value).filter(([key]) => !["signature", "thinkingSignature", "textSignature"].includes(key)).map(([key, item]) => [key, displayValue(item, depth + 1)]));
}

export interface ConversationBlock { id: string; component: Component }
export interface ConversationDocument { lines: string[]; anchors: Array<{ id: string; line: number }> }
const nativeTools = (cwd: string) => [createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd)];

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((part) => part.type === "text" ? [part.text] : part.type === "image" ? ["[Image]"] : []).join("\n");
}

/** Pi renders text, images, thinking and tool calls; a tool result always has its own card. */
function messageIsRenderable(message: Message): boolean {
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0;
	return content.some((part) => {
		switch (part.type) {
			case "text": return part.text.trim().length > 0;
			case "image": return true;
			case "toolCall": return true;
			case "thinking": return part.thinking.trim().length > 0 || part.redacted === true;
			default: return false;
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
		if (entry.kind === "pi.tool-result") return true;
		return (entry.model ?? []).some(messageIsRenderable);
	});
}

/**
 * First user task recovered from the session summary when the bounded
 * transcript dropped the oldest entries. The summary carries the first input
 * independently of the transcript bound, so the task stays visible.
 */
export function firstTaskEntry(
	snapshot: { readonly entries: readonly AgentConversationEntry[]; readonly partial: boolean },
	row: { readonly firstMessage?: string } | undefined,
): AgentConversationEntry | undefined {
	if (!snapshot.partial) return undefined;
	const first = (row?.firstMessage ?? "").trim();
	if (first === "") return undefined;
	const present = snapshot.entries.some((entry) => entry.kind === "pi.user" && (entry.model ?? []).some((message) => contentText(message.content).startsWith(first)));
	if (present) return undefined;
	return { id: "first-task", kind: "pi.user", model: [{ role: "user", content: row?.firstMessage ?? first, timestamp: 0 }] };
}

function entryTimestamp(entry: AgentConversationEntry): number {
	for (const message of entry.model ?? []) if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
	return 0;
}

/** A conversation transcript uses Pi's public chat components and built-in tool presentation. */
export class AgentConversation {
	private blocks: ConversationBlock[] = [];
	private cache?: { width: number; document: ConversationDocument };
	private readonly definitions: ReturnType<typeof nativeTools>;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private readonly expanded: boolean;
	private readonly showThinking: boolean;
	constructor(entries: readonly AgentConversationEntry[], cwd: string, tui: TUI, expanded: boolean, showThinking: boolean) {
		this.cwd = cwd; this.tui = tui; this.expanded = expanded; this.showThinking = showThinking;
		this.definitions = nativeTools(cwd);
		for (const source of entries) this.appendEntry(source);
	}
	private appendEntry(source: AgentConversationEntry): void {
		try {
			const entry = displayValue(source) as AgentConversationEntry;
			if (entry.kind === "pi.compaction") { this.appendCompaction(entry); return; }
			if (entry.kind === "pi.reset") this.blocks.push({ id: `${entry.id}:reset`, component: new Text("── New context ──", 1, 1) });
			for (const message of entry.model ?? []) this.appendMessage(entry.id, message);
		} catch { this.blocks.push({ id: source.id, component: new Text("[Message unavailable: invalid stored content]", 1, 1) }); }
	}
	/** Native compaction entries keep their wrapped summary text under a distinct label. */
	private appendCompaction(entry: AgentConversationEntry): void {
		const text = (entry.model ?? []).map((message) => contentText(message.content)).join("\n").trim();
		const message = { role: "custom" as const, customType: "compaction", content: text || "Compaction summary text is unavailable", display: true, timestamp: entryTimestamp(entry) };
		const component = new CustomMessageComponent(message, undefined, getMarkdownTheme());
		component.setExpanded(this.expanded);
		this.blocks.push({ id: entry.id, component });
	}
	private tool(name: string, id: string, args: unknown, known = true): ToolExecutionComponent {
		const definition = known ? this.definitions.find((item) => item.name === name) : undefined;
		// Pi's generic card prints a JSON object; an empty one renders as a bare `{}`.
		const shown = args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0 ? undefined : args;
		const tool = new ToolExecutionComponent(name, id, shown, { showImages: false }, definition, this.tui, this.cwd);
		tool.setExpanded(this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage): void {
		this.blocks.push({ id, component: new AssistantMessageComponent(message, !this.showThinking, getMarkdownTheme(), "Thinking...") });
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const tool = this.tool(part.name, part.id, part.arguments);
			if (message.stopReason === "error" || message.stopReason === "aborted") tool.updateResult({ content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation stopped" : "Operation failed") }], isError: true });
			this.tools.set(part.id, tool);
			this.blocks.push({ id: `${id}:${part.id}`, component: tool });
		}
	}
	private appendResult(id: string, message: ToolResultMessage): void {
		let tool = this.tools.get(message.toolCallId);
		if (!tool) { tool = this.tool(message.toolName, message.toolCallId, undefined, false); this.blocks.push({ id, component: tool }); }
		tool.updateResult(message);
	}
	private appendMessage(id: string, message: Message): void {
		const markdown = getMarkdownTheme();
		let component: Component | undefined;
		switch (message.role) {
			case "assistant": this.appendAssistant(id, message); return;
			case "toolResult": this.appendResult(id, message); return;
			case "user":
				component = new UserMessageComponent(contentText(message.content), markdown); break;
			case "system": {
				const text = contentText(message.content).trim();
				if (text) component = new Text(text, 1, 1); break;
			}
		}
		if (component) this.blocks.push({ id, component });
	}
	render(width: number): ConversationDocument {
		if (this.cache?.width === width) return this.cache.document;
		const document: ConversationDocument = { lines: [], anchors: [] };
		for (const { id, component } of this.blocks) {
			let rendered: string[];
			try { rendered = component.render(width); }
			catch { rendered = ["[Message unavailable: renderer rejected stored content]"]; }
			// Each native component pads itself; keep one blank line between blocks.
			const first = rendered.findIndex((line) => cleanDashboardText(line).trim() !== "");
			if (first < 0) continue;
			let last = rendered.length - 1;
			while (last > first && cleanDashboardText(rendered[last] ?? "").trim() === "") last--;
			if (document.lines.length > 0) document.lines.push("");
			document.anchors.push({ id, line: document.lines.length });
			document.lines.push(...rendered.slice(first, last + 1));
		}
		this.cache = { width, document };
		return document;
	}
	invalidate(): void { this.cache = undefined; for (const block of this.blocks) block.component.invalidate(); }
}
