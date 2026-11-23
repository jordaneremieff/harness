import type { Static } from "@earendil-works/pi-schema";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishSettings, readSettings } from "./settings.ts";
import { registerProactive } from "./proactive-ordinary.ts";
import { createMemoryContribution } from "./durable.ts";
import { toolDisplay } from "./display.ts";
import { historyMemory, memoryIndex, readMemory, searchMemory } from "./retrieval.ts";
import { memorySourceCache } from "./source-cache.ts";
import { memorySearchOutputSchema } from "./search-output.ts";
import {
	editMemory,
	memoryRoot,
	MemoryWriteError,
	retireMemory,
	reviewMemory,
	type WriteReceipt,
	writeMemory,
} from "./store.ts";
import {
	MEMORY_REVIEW_GUIDELINES,
	MEMORY_SEARCH_GUIDELINES,
	MEMORY_TOOL_DESCRIPTIONS,
	MEMORY_WRITE_GUIDELINES,
	memoryMutationResult,
	memoryToolArguments,
} from "./tool-contract.ts";

async function mutation(root: string, signal: AbortSignal | undefined, operation: () => WriteReceipt) {
	const abortedBeforeExecution = signal?.aborted;
	try {
		const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () => operation());
		return memoryMutationResult(root, details);
	} catch (error) {
		if (abortedBeforeExecution || !(error instanceof MemoryWriteError)) throw error;
		return { isError: true, content: [{ type: "text" as const, text: error.message }], details: error.receipt };
	}
}

export default function memory(pi: ExtensionAPI): void {
	const configuration = () => readSettings({ agentDir: getAgentDir() }).values;
	const configuredDir = () => configuration().dir;
	registerProactive(pi, configuration);
	const disposeSettings = publishSettings(pi.events, { agentDir: getAgentDir() });
	pi.on("session_shutdown", () => {
		disposeSettings();
		memorySourceCache.clear();
	});
	const displays = new Map(toolDisplay().tools.map((tool) => [tool.name, tool]));
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		pi.registerTool({ ...tool, ...displays.get(tool.name) });
	};
	pi.events.emit(
		"durable:contribution",
		createMemoryContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	let index: Promise<string | undefined> | undefined;
	const resetIndex = () => {
		index = undefined;
	};
	pi.on("session_start", resetIndex);
	pi.on("session_compact", resetIndex);
	pi.on("before_agent_start", async (event, ctx) => {
		delete event.systemPromptOptions.sections.memory_index;
		if (index === undefined) {
			const config = configuration();
			index = memoryIndex(config.dir, ctx.signal, config.proactive, ctx.cwd);
		}
		const pending = index;
		const section = await pending;
		if (ctx.signal?.aborted && index === pending) resetIndex();
		if (section !== undefined) event.systemPromptOptions.sections.memory_index = section;
	});
	registerTool({
		name: "memory_search",
		label: "Memory search",
		description: MEMORY_TOOL_DESCRIPTIONS.search,
		promptGuidelines: [...MEMORY_SEARCH_GUIDELINES],
		...memoryToolArguments.search,
		outputSchema: memorySearchOutputSchema,
		async execute(_id, args: Static<typeof memoryToolArguments.search.parameters>, signal) {
			const details = await searchMemory(memoryRoot(configuredDir()), args, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
				structuredContent: details as JsonObject,
			};
		},
	});
	registerTool({
		name: "memory_read",
		label: "Memory read",
		description: MEMORY_TOOL_DESCRIPTIONS.read,
		...memoryToolArguments.read,
		async execute(_id, args: Static<typeof memoryToolArguments.read.parameters>, signal) {
			const details = await readMemory(memoryRoot(configuredDir()), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	registerTool({
		name: "memory_history",
		label: "Memory history",
		description: MEMORY_TOOL_DESCRIPTIONS.history,
		...memoryToolArguments.history,
		async execute(_id, args: Static<typeof memoryToolArguments.history.parameters>, signal) {
			const details = await historyMemory(memoryRoot(configuredDir()), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	registerTool({
		name: "memory_write",
		label: "Memory write",
		description: MEMORY_TOOL_DESCRIPTIONS.write,
		promptGuidelines: [...MEMORY_WRITE_GUIDELINES],
		...memoryToolArguments.write,
		async execute(_id, args: Static<typeof memoryToolArguments.write.parameters>, signal) {
			const root = memoryRoot(configuredDir());
			return mutation(root, signal, () => writeMemory(root, args, signal));
		},
	});
	registerTool({
		name: "memory_edit",
		label: "Memory edit",
		description: MEMORY_TOOL_DESCRIPTIONS.edit,
		...memoryToolArguments.edit,
		async execute(_id, args: Static<typeof memoryToolArguments.edit.parameters>, signal) {
			const root = memoryRoot(configuredDir());
			return mutation(root, signal, () => editMemory(root, args, signal));
		},
	});
	registerTool({
		name: "memory_review",
		label: "Memory review",
		description: MEMORY_TOOL_DESCRIPTIONS.review,
		promptGuidelines: [...MEMORY_REVIEW_GUIDELINES],
		...memoryToolArguments.review,
		async execute(_id, args: Static<typeof memoryToolArguments.review.parameters>, signal) {
			const root = memoryRoot(configuredDir());
			return mutation(root, signal, () => reviewMemory(root, args, signal));
		},
	});
	registerTool({
		name: "memory_retire",
		label: "Memory retire",
		description: MEMORY_TOOL_DESCRIPTIONS.retire,
		...memoryToolArguments.retire,
		async execute(_id, args: Static<typeof memoryToolArguments.retire.parameters>, signal) {
			const root = memoryRoot(configuredDir());
			return mutation(root, signal, () => retireMemory(root, args, signal));
		},
	});
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1) {
			publishDisplay();
		}
	});
	publishDisplay();
}
