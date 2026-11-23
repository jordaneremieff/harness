import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { publishSettings, readSettings, type SettingsBus } from "./settings.ts";
import { durableRecall } from "./proactive-durable.ts";
import { historyMemory, memoryIndex, readMemory, searchMemory } from "./retrieval.ts";
import { memorySourceCache } from "./source-cache.ts";
import { memorySearchOutputSchema } from "./search-output.ts";
import { editMemory, memoryRoot, retireMemory, reviewMemory, type WriteReceipt, writeMemory } from "./store.ts";
import {
	MEMORY_GUIDELINES,
	MEMORY_TOOL_DESCRIPTIONS,
	memoryMutationText,
	memoryToolArguments,
} from "./tool-contract.ts";

/**
 * Native Pi Durable form of the memory extension.
 *
 * The corpus and its revision history stay external, as in the ordinary form.
 * Task memos retain bounded discovery notices for request retries. Every tool keeps
 * the ordinary name, parameter schema, details, and execution against the configured corpus; the
 * ordinary same-process mutation queue serializes corpus writes.
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
	/** The host's open Harness, available from `create()`. */
	readonly harness: Durable.Harness;
	readonly signal: AbortSignal;
	onClose(dispose: () => void | Promise<void>): void;
	readonly inventory: MemoryDurableInventory;
}

export interface MemoryDurableContribution {
	readonly name: string;
	/** Absolute path of the emitting entrypoint, resolved by the host against loaded extensions. */
	readonly source: string;
	readonly display: { readonly version: 1; readonly entry: "./display.ts"; readonly export: "toolDisplay" };
	create(host: MemoryDurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

const INDEX_CONVERSATION_LIMIT = 64;

/** Model-facing usage guidance as one section, because Durable tools carry no promptGuidelines. */
function memoryGuidance(): string {
	return MEMORY_GUIDELINES.map((line) => `- ${line}`).join("\n");
}

export function createMemoryContribution(
	source: string,
	bus: SettingsBus,
	disposeOrdinarySettings: () => void,
): MemoryDurableContribution {
	return {
		name: "memory",
		source,
		display: { version: 1, entry: "./display.ts", export: "toolDisplay" },
		create(host) {
			disposeOrdinarySettings();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			host.onClose(() => memorySourceCache.clear());
			const { defineExtension, defineTool, section } = host.durable;
			const configuration = () => readSettings({ agentDir: host.agentDir }).values;
			const indexes = new Map<Durable.ConversationId, Promise<string | undefined>>();
			let observation: Durable.CommitObservation | undefined;
			host.onClose(() => observation?.detach());
			const indexSection = async (input: Durable.PromptInput, context: Context) => {
				// Invalidate on the committed compaction marker, not when compaction starts.
				observation ??= host.harness.observeCommits({
					advance({ changes }) {
						for (const change of changes) {
							if (change.type === "entry" && change.value.head !== undefined) {
								indexes.delete(change.value.conversationId);
							}
						}
					},
					end() {},
				});
				const id = input.conversationId;
				const existing = indexes.get(id);
				if (existing !== undefined) {
					indexes.delete(id);
					indexes.set(id, existing);
					return existing;
				}
				const config = configuration();
				const pending = memoryIndex(config.dir, context.abortSignal, config.proactive, input.agent.cwd ?? host.cwd);
				indexes.set(id, pending);
				if (indexes.size > INDEX_CONVERSATION_LIMIT) {
					const oldest = indexes.keys().next().value;
					if (oldest !== undefined) indexes.delete(oldest);
				}
				const text = await pending;
				if (context.abortSignal?.aborted && indexes.get(id) === pending) indexes.delete(id);
				return text;
			};
			const configuredDir = () => configuration().dir;
			// The ordinary memory_search returns the page as both details and structuredContent.
			const searchResult = (details: Record<string, unknown>) => {
				const structured = details as Durable.JsonObject;
				return {
					output: [{ type: "text" as const, text: JSON.stringify(details) }],
					structuredOutput: structured,
					details: structured,
				};
			};
			// The other ordinary reads return the page as details only.
			const plainResult = (details: Record<string, unknown>) => ({
				output: [{ type: "text" as const, text: JSON.stringify(details) }],
				details: details as Durable.JsonObject,
			});
			const mutationResult = (root: string, details: WriteReceipt) => ({
				output: [{ type: "text" as const, text: memoryMutationText(root, details) }],
				details: details as unknown as Durable.JsonObject,
			});
			const onCorpusLock = (root: string, operation: () => WriteReceipt): Promise<WriteReceipt> =>
				withFileMutationQueue(join(root, ".memory-write.lock"), async () => operation());
			const searchTool = defineTool({
				name: "memory_search",
				description: MEMORY_TOOL_DESCRIPTIONS.search,
				...memoryToolArguments.search,
				structuredOutputSchema: memorySearchOutputSchema,
				replay: "safe",
				execute: async (args, _api, context) => {
					const details = await searchMemory(memoryRoot(configuredDir()), args, context.abortSignal);
					return searchResult(details);
				},
			});
			return defineExtension({
				name: "memory",
				hooks: [
					host.durable.hook(
						host.durable.GenerationTask,
						durableRecall(configuration, async (data, api, context) => {
							await host.harness.commit(
								(tx) => tx.appendEntry(api.conversationId, { kind: "memory.notice", data }),
								context,
							);
						}),
					),
				],
				sections: [section("memory", () => memoryGuidance()), section("memory_index", indexSection)],
				tools: [
					searchTool,
					defineTool({
						name: "memory_read",
						description: MEMORY_TOOL_DESCRIPTIONS.read,
						...memoryToolArguments.read,
						replay: "safe",
						execute: async (args, _api, context) => {
							const details = await readMemory(memoryRoot(configuredDir()), args, context.abortSignal);
							return plainResult(details);
						},
					}),
					defineTool({
						name: "memory_history",
						description: MEMORY_TOOL_DESCRIPTIONS.history,
						...memoryToolArguments.history,
						replay: "safe",
						execute: async (args, _api, context) => {
							const details = await historyMemory(memoryRoot(configuredDir()), args, context.abortSignal);
							return plainResult(details);
						},
					}),
					defineTool({
						name: "memory_write",
						description: MEMORY_TOOL_DESCRIPTIONS.write,
						...memoryToolArguments.write,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot(configuredDir());
							const details = await onCorpusLock(root, () => writeMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_edit",
						description: MEMORY_TOOL_DESCRIPTIONS.edit,
						...memoryToolArguments.edit,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot(configuredDir());
							const details = await onCorpusLock(root, () => editMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_review",
						description: MEMORY_TOOL_DESCRIPTIONS.review,
						...memoryToolArguments.review,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot(configuredDir());
							const details = await onCorpusLock(root, () => reviewMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
					defineTool({
						name: "memory_retire",
						description: MEMORY_TOOL_DESCRIPTIONS.retire,
						...memoryToolArguments.retire,
						replay: "unsafe",
						execute: async (args, _api, context) => {
							const root = memoryRoot(configuredDir());
							const details = await onCorpusLock(root, () => retireMemory(root, args, context.abortSignal));
							return mutationResult(root, details);
						},
					}),
				],
			});
		},
	};
}
