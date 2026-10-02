import type { JsonObject } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryContribution } from "./durable.ts";
import { renderCall, renderResult } from "./presentation.ts";
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
	pi.events.emit("durable:contribution", createMemoryContribution(fileURLToPath(import.meta.url)));
	pi.on("before_agent_start", async (event, ctx) => {
		delete event.systemPromptOptions.sections.memory_index;
		const section = await memoryIndex(process.env.PI_MEMORY_DIR, ctx.signal);
		if (section !== undefined) event.systemPromptOptions.sections.memory_index = section;
	});
	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description: MEMORY_TOOL_DESCRIPTIONS.search,
		promptGuidelines: [...MEMORY_SEARCH_GUIDELINES],
		parameters: memorySearchParameters,
		outputSchema: memorySearchOutputSchema,
		async execute(_id, args, signal) {
			const details = await searchMemory(memoryRoot(), args, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
				structuredContent: details as JsonObject,
			};
		},
		renderCall: (args, theme, context) => renderCall("memory_search", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_search", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_read",
		label: "Memory read",
		description: MEMORY_TOOL_DESCRIPTIONS.read,
		parameters: memoryReadParameters,
		async execute(_id, args, signal) {
			const details = await readMemory(memoryRoot(), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
		renderCall: (args, theme, context) => renderCall("memory_read", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_read", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_history",
		label: "Memory history",
		description: MEMORY_TOOL_DESCRIPTIONS.history,
		parameters: memoryHistoryParameters,
		async execute(_id, args, signal) {
			const details = await historyMemory(memoryRoot(), args, signal);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
		renderCall: (args, theme, context) => renderCall("memory_history", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_history", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_write",
		label: "Memory write",
		description: MEMORY_TOOL_DESCRIPTIONS.write,
		promptGuidelines: [...MEMORY_WRITE_GUIDELINES],
		parameters: memoryWriteParameters,
		async execute(_id, args, signal) {
			const root = memoryRoot();
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				writeMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
		renderCall: (args, theme, context) => renderCall("memory_write", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_write", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_edit",
		label: "Memory edit",
		description: MEMORY_TOOL_DESCRIPTIONS.edit,
		parameters: memoryEditParameters,
		async execute(_id, args, signal) {
			const root = memoryRoot();
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				editMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
		renderCall: (args, theme, context) => renderCall("memory_edit", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_edit", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_review",
		label: "Memory review",
		description: MEMORY_TOOL_DESCRIPTIONS.review,
		promptGuidelines: [...MEMORY_REVIEW_GUIDELINES],
		parameters: memoryReviewParameters,
		async execute(_id, args, signal) {
			const root = memoryRoot();
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				reviewMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
		renderCall: (args, theme, context) => renderCall("memory_review", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_review", result, options, theme, context),
	});
	pi.registerTool({
		name: "memory_retire",
		label: "Memory retire",
		description: MEMORY_TOOL_DESCRIPTIONS.retire,
		parameters: memoryRetireParameters,
		async execute(_id, args, signal) {
			const root = memoryRoot();
			const details = await withFileMutationQueue(join(root, ".memory-write.lock"), async () =>
				retireMemory(root, args, signal),
			);
			return memoryMutationResult(root, details);
		},
		renderCall: (args, theme, context) => renderCall("memory_retire", args, theme, context),
		renderResult: (result, options, theme, context) => renderResult("memory_retire", result, options, theme, context),
	});
}
