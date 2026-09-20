import assert from "node:assert/strict";
import type { Api, Model, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { StashPanel, StashPanelResult, PanelTheme } from "./panel.ts";
import type { DistillModelRegistry } from "./distill.ts";

export function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
		...overrides,
	};
}

export class RequiredMap<K, V> extends Map<K, V> {
	override get(key: K): V {
		const value = super.get(key);
		assert.ok(value !== undefined, `missing registered item ${String(key)}`);
		return value;
	}
}

export type PanelFactory = (
	tui: { terminal: { rows: number }; requestRender(): void },
	theme: PanelTheme,
	keybindings: object,
	done: (result: StashPanelResult) => void,
) => StashPanel;
export type CustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
export type TestUi = Partial<Omit<ExtensionUIContext, "custom">> & {
	custom?: (factory: PanelFactory, options?: CustomOptions) => Promise<StashPanelResult>;
};
export interface TestContext {
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	cwd?: string;
	isIdle?: () => boolean;
	ui?: TestUi;
	model?: Model<Api>;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	modelRegistry?: DistillModelRegistry;
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionId" | "buildContextEntries">;
}

// These entrypoint drives supply only the context members each exercised path reads.
// The adapter is the sole boundary to Pi's full host context; omitted services are not simulated.
export function hostContext(ctx: TestContext = {}): ExtensionCommandContext {
	return ctx as ExtensionCommandContext;
}

export function captureCommand(command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
	return {
		...command,
		getArgumentCompletions: async (text: string) => {
			assert.ok(command.getArgumentCompletions);
			return command.getArgumentCompletions(text);
		},
		handler: (args: string, ctx: TestContext) => command.handler(args, hostContext(ctx)),
	};
}

export function captureTool<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>) {
	return {
		name: tool.name,
		execute: async (id: string, params: unknown, signal?: AbortSignal, _update?: undefined, ctx?: TestContext) => {
			assert.ok(Value.Check(tool.parameters, params), "tool arguments satisfy the registered schema");
			const result = await tool.execute(id, params, signal, undefined, hostContext(ctx));
			assert.ok(typeof result.details === "object" && result.details !== null);
			const details: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(result.details)) details[key] = value;
			const content = result.content.map((part) => {
				assert.equal(part.type, "text");
				if (part.type !== "text") throw new Error("expected text output");
				return part;
			});
			return { ...result, content, details };
		},
	};
}

export function stringArray(value: unknown): string[] {
	assert.ok(Array.isArray(value));
	return value.map((item: unknown) => {
		assert.ok(typeof item === "string");
		return item;
	});
}

type EntryInput =
	| { type: "message"; message: { role: "user"; content: string } }
	| { type: "message"; message: { role: "assistant"; content: Array<TextContent | ThinkingContent | ToolCall> } }
	| {
			type: "message";
			message: {
				role: "toolResult";
				content: Array<{ type: "text"; text: string }>;
				toolName: string;
				toolCallId?: string;
				isError: boolean;
			};
	  }
	| { type: "compaction"; summary: string }
	| { type: "custom_message"; customType: string; content: string; display: boolean };

export function transcriptEntries(inputs: EntryInput[]): SessionEntry[] {
	return inputs.map((entry, index): SessionEntry => {
		const base = { id: `entry-${index}`, parentId: null, timestamp: new Date(0).toISOString() };
		if (entry.type === "compaction") return { ...base, ...entry, firstKeptEntryId: "entry-0", tokensBefore: 0 };
		if (entry.type === "custom_message") return { ...base, ...entry };
		const message = entry.message;
		switch (message.role) {
			case "user":
				return { ...base, type: "message", message: { ...message, timestamp: 0 } };
			case "toolResult":
				return { ...base, type: "message", message: { toolCallId: "call", ...message, timestamp: 0 } };
			case "assistant":
				return {
					...base,
					type: "message",
					message: {
						...message,
						api: "openai-completions",
						provider: "test",
						model: "test-model",
						stopReason: "stop",
						timestamp: 0,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				};
			default:
				throw new Error("unsupported transcript fixture role");
		}
	});
}
