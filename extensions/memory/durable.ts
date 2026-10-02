import { join } from "node:path";
import type * as Durable from "@earendil-works/pi-durable";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { historyMemory, memoryIndex, readMemory, searchMemory } from "./retrieval.ts";
import { memorySearchOutputSchema } from "./search-output.ts";
import { editMemory, memoryRoot, retireMemory, reviewMemory, type WriteReceipt, writeMemory } from "./store.ts";
import {
	MEMORY_GUIDELINES,
	MEMORY_TOOL_DESCRIPTIONS,
	memoryEditParameters,
	memoryHistoryParameters,
	memoryMutationText,
	memoryReadParameters,
	memoryRetireParameters,
	memoryReviewParameters,
	memorySearchParameters,
	memoryWriteParameters,
} from "./tool-contract.ts";

/**
 * Native Pi Durable form of the memory extension.
 *
 * The corpus and its revision history stay external, as in the ordinary form.
 * Nothing is copied into Durable documents. Every tool keeps the ordinary
 * name, parameter schema, and execution against `PI_MEMORY_DIR`; the ordinary
 * same-process mutation queue serializes corpus writes.
 *
 * Replay classes are explicit per tool. Reads rescan current sources and
 * repeat no external effect, so they are replay-safe. Mutations publish a
 * planned set of files without a durable operation identity: a rerun after
 * process loss can refuse after a partial publication or capture history
 * again, so they stay unsafe and an interruption produces an interrupted
 * result. The model inspects the corpus before retrying.
 */

export interface MemoryDurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	readonly ordinaryOnly: readonly string[];
}

export interface MemoryDurableContributionHost {
	/** The host's pi-durable module; every pi-durable runtime value comes from it. */
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly signal: AbortSignal;
	readonly inventory: MemoryDurableInventory;
}

export interface MemoryDurableContribution {
	readonly name: string;
	/** Absolute path of the emitting entrypoint, resolved by the host against loaded extensions. */
	readonly source: string;
	create(host: MemoryDurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

/** Model-facing usage guidance as one section, because Durable tools carry no promptGuidelines. */
function memoryGuidance(): string {
	return MEMORY_GUIDELINES.map((line) => `- ${line}`).join("\n");
}

export function createMemoryContribution(source: string): MemoryDurableContribution {
	return {
		name: "memory",
		source,
		create(host) {
			const { defineExtension, defineTool, section } = host.durable;
			const readResult = (details: Record<string, unknown>) => ({
				content: [{ type: "text" as const, text: JSON.stringify(details) }],
				details: { structuredContent: details as Durable.JsonObject },
			});
			const mutationResult = (root: string, details: WriteReceipt) => ({
				content: [{ type: "text" as const, text: memoryMutationText(root, details) }],
				details: { structuredContent: details as unknown as Durable.JsonObject },
			});
			const onCorpusLock = (root: string, operation: () => WriteReceipt): Promise<WriteReceipt> =>
				withFileMutationQueue(join(root, ".memory-write.lock"), async () => operation());
			const searchTool = {
				...defineTool({
					name: "memory_search",
					description: MEMORY_TOOL_DESCRIPTIONS.search,
					parameters: memorySearchParameters,
					replay: "safe",
					execute: async (args, _api, context) => {
						const details = await searchMemory(memoryRoot(), args, context.abortSignal);
						return readResult(details);
					},
				}),
				// pi-durable ignores the extra property; nested-call declarations read it.
				outputSchema: memorySearchOutputSchema,
			};
			return defineExtension({
				name: "memory",
				sections: [
					section("memory", () => memoryGuidance()),
					// The index text depends only on corpus content. A stable corpus
					// renders identical bytes, so the section adds no prompt delta and
					// provider caches stay warm; a changed corpus reaches the next request.
					section("memory_index", (_input, context) =>
						memoryIndex(process.env.PI_MEMORY_DIR, context.abortSignal),
					),
				],
				tools: [
					searchTool,
					defineTool({
						name: "memory_read",
						description: MEMORY_TOOL_DESCRIPTIONS.read,
						parameters: memoryReadParameters,
						replay: "safe",
						execute: async (args, _api, context) => {
							const details = await readMemory(memoryRoot(), args, context.abortSignal);
							return readResult(details);
						},
					}),
					defineTool({
						name: "memory_history",
						description: MEMORY_TOOL_DESCRIPTIONS.history,
						parameters: memoryHistoryParameters,
						replay: "safe",
						execute: async (args, _api, context) => {
							const details = await historyMemory(memoryRoot(), args, context.abortSignal);
							return readResult(details);
						},
					}),
					defineTool({
						name: "memory_write",
						description: MEMORY_TOOL_DESCRIPTIONS.write,
						parameters: memoryWriteParameters,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot();
							const details = await onCorpusLock(root, () => writeMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_edit",
						description: MEMORY_TOOL_DESCRIPTIONS.edit,
						parameters: memoryEditParameters,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot();
							const details = await onCorpusLock(root, () => editMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_review",
						description: MEMORY_TOOL_DESCRIPTIONS.review,
						parameters: memoryReviewParameters,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot();
							const details = await onCorpusLock(root, () => reviewMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_retire",
						description: MEMORY_TOOL_DESCRIPTIONS.retire,
						parameters: memoryRetireParameters,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot();
							const details = await onCorpusLock(root, () => retireMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
				],
			});
		},
	};
}
