import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent,
	CustomMessageComponent, ToolExecutionComponent, UserMessageComponent,
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	getMarkdownTheme, sessionEntryToContextMessages, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

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

/** A selected branch uses Pi's public chat components and built-in tool presentation. */
export class AgentConversation {
	private blocks: ConversationBlock[] = [];
	private cache?: { width: number; document: ConversationDocument };
	private readonly definitions: ReturnType<typeof nativeTools>;
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private readonly cwd: string;
	private readonly tui: TUI;
	private readonly expanded: boolean;
	private readonly showThinking: boolean;
	constructor(entries: SessionEntry[], cwd: string, tui: TUI, expanded: boolean, showThinking: boolean) {
		this.cwd = cwd; this.tui = tui; this.expanded = expanded; this.showThinking = showThinking;
		this.definitions = nativeTools(cwd);
		for (const source of entries) this.appendEntry(source);
	}
	private appendEntry(source: SessionEntry): void {
		try {
			const entry = displayValue(source) as SessionEntry;
			for (const message of sessionEntryToContextMessages(entry)) this.appendMessage(entry.id, message);
		} catch { this.blocks.push({ id: source.id, component: new Text("[Message unavailable: invalid stored content]", 1, 1) }); }
	}
	private tool(name: string, id: string, args: unknown, known = true): ToolExecutionComponent {
		const definition = known ? this.definitions.find((item) => item.name === name) : undefined;
		const tool = new ToolExecutionComponent(name, id, args, { showImages: false }, definition, this.tui, this.cwd);
		tool.setExpanded(this.expanded);
		return tool;
	}
	private appendAssistant(id: string, message: AssistantMessage): void {
		this.blocks.push({ id, component: new AssistantMessageComponent(message, !this.showThinking, getMarkdownTheme(), "Thinking (collapsed)") });
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
		if (!tool) { tool = this.tool(message.toolName, message.toolCallId, {}, false); this.blocks.push({ id, component: tool }); }
		tool.updateResult(message);
	}
	private appendMessage(id: string, message: AgentMessage): void {
		const markdown = getMarkdownTheme();
		let component: Component | undefined;
		switch (message.role) {
			case "assistant": this.appendAssistant(id, message); return;
			case "toolResult": this.appendResult(id, message); return;
			case "user":
				component = new UserMessageComponent(typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[Image]").join("\n"), markdown); break;
			case "custom":
				if (message.display) { const custom = new CustomMessageComponent(message, undefined, markdown); custom.setExpanded(this.expanded); component = custom; } break;
			case "compactionSummary": {
				const summary = new CompactionSummaryMessageComponent(message, markdown); summary.setExpanded(this.expanded); component = summary; break;
			}
			case "branchSummary": {
				const summary = new BranchSummaryMessageComponent(message, markdown); summary.setExpanded(this.expanded); component = summary; break;
			}
			case "bashExecution": {
				const tool = this.tool("bash", id, { command: message.command });
				tool.updateResult({ content: [{ type: "text", text: message.output }], isError: message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0) }); component = tool; break;
			}
		}
		if (component) this.blocks.push({ id, component });
	}
	render(width: number): ConversationDocument {
		if (this.cache?.width === width) return this.cache.document;
		const document: ConversationDocument = { lines: [], anchors: [] };
		for (const { id, component } of this.blocks) {
			document.anchors.push({ id, line: document.lines.length });
			try { document.lines.push(...component.render(width)); }
			catch { document.lines.push("[Message unavailable: renderer rejected stored content]"); }
		}
		this.cache = { width, document };
		return document;
	}
	invalidate(): void { this.cache = undefined; for (const block of this.blocks) block.component.invalidate(); }
}
