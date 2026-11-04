import type { Static } from "@earendil-works/pi-schema";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishSettings, readSettings } from "./settings.ts";
import { registerProactive } from "./proactive-ordinary.ts";
import { createMemoryContribution } from "./durable.ts";
import { toolDisplay } from "./display.ts";
import { historyMemory, memoryIndex, readMemory, searchMemory } from "./retrieval.ts";
import { memorySearchOutputSchema } from "./search-output.ts";
import { editMemory, memoryRoot, retireMemory, reviewMemory, writeMemory } from "./store.ts";
import {
	MEMORY_REVIEW_GUIDELINES,
	MEMORY_SEARCH_GUIDELINES,
	MEMORY_TOOL_DESCRIPTIONS,
	MEMORY_WRITE_GUIDELINES,
	memoryEditParameters,
	memoryHistoryParameters,
	memoryMutationResult,
	memoryReadParameters,
	memoryRetireParameters,
	memoryReviewParameters,
	memorySearchParameters,
	memoryWriteParameters,
} from "./tool-contract.ts";

export default function memory(pi: ExtensionAPI): void {
	const configuration = () => readSettings({ agentDir: getAgentDir() }).values;
	const configuredDir = () => configuration().dir;
	registerProactive(pi, configuration);
	const disposeSettings = publishSettings(pi.events, { agentDir: getAgentDir() });
	pi.on("session_shutdown", disposeSettings);
	const displays = new Map(toolDisplay().tools.map((tool) => [tool.name, tool]));
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		pi.registerTool({ ...tool, ...displays.get(tool.name) });
	};
	pi.events.emit(
		"durable:contribution",
		createMemoryContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	pi.on("before_agent_start", async (event, ctx) => {
		delete event.systemPromptOptions.sections.memory_index;
		const config = configuration();
		const section = await memoryIndex(config.dir, ctx.signal, config.proactive);
		if (section !== undefined) event.systemPromptOptions.sections.memory_index = section;
	});
	registerTool({
		name: "memory_search",
		label: "Memory search",
		description: MEMORY_TOOL_DESCRIPTIONS.search,
		promptGuidelines: [...MEMORY_SEARCH_GUIDELINES],
		parameters: memorySearchParameters,
		outputSchema: memorySearchOutputSchema,
		async execute(_id, args: Static<typeof memorySearchParameters>, signal) {
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
		parameters: memoryReadParameters,
		async execute(_id, args: Static<typeof memoryReadParameters>, signal) {
			const details = await readMemory(memoryRoot(configuredDir()), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	registerTool({
		name: "memory_history",
		label: "Memory history",
		description: MEMORY_TOOL_DESCRIPTIONS.history,
		parameters: memoryHistoryParameters,
		async execute(_id, args: Static<typeof memoryHistoryParameters>, signal) {
			const details = await historyMemory(memoryRoot(configuredDir()), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	registerTool({
		name: "memory_write",
		label: "Memory write",
		description: MEMORY_TOOL_DESCRIPTIONS.write,
		promptGuidelines: [...MEMORY_WRITE_GUIDELINES],
		parameters: memoryWriteParameters,
		async execute(_id, args: Static<typeof memoryWriteParameters>, signal) {
			const root = memoryRoot(configuredDir());
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				writeMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
	});
	registerTool({
		name: "memory_edit",
		label: "Memory edit",
		description: MEMORY_TOOL_DESCRIPTIONS.edit,
		parameters: memoryEditParameters,
		async execute(_id, args: Static<typeof memoryEditParameters>, signal) {
			const root = memoryRoot(configuredDir());
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				editMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
	});
	registerTool({
		name: "memory_review",
		label: "Memory review",
		description: MEMORY_TOOL_DESCRIPTIONS.review,
		promptGuidelines: [...MEMORY_REVIEW_GUIDELINES],
		parameters: memoryReviewParameters,
		async execute(_id, args: Static<typeof memoryReviewParameters>, signal) {
			const root = memoryRoot(configuredDir());
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				reviewMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
	});
	registerTool({
		name: "memory_retire",
		label: "Memory retire",
		description: MEMORY_TOOL_DESCRIPTIONS.retire,
		parameters: memoryRetireParameters,
		async execute(_id, args: Static<typeof memoryRetireParameters>, signal) {
			const root = memoryRoot(configuredDir());
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				retireMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
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
