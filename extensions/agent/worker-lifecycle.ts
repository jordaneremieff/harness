import { isDeepStrictEqual } from "node:util";
import {
	type AgentHarness,
	type AgentMessage,
	type Context,
	createBranchSummaryMessage,
	type Entry,
	type JsonValue,
	type Session,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	collectEntriesForBranchSummary,
	type ExtensionRunner,
	type SessionBeforeCompactEvent,
	type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionView } from "./session-view.ts";
import { corePublicImportUrl } from "./store.ts";

const { setValue, value: valueAddress } = (await import(
	corePublicImportUrl("./harness/session")
)) as typeof import("@earendil-works/pi-agent-core/harness/session");

export interface WorkerNavigationDecision {
	cancel?: boolean;
	summary?: { summary: string; details?: unknown; usage?: Usage };
}

export const COMPACTION_POINTER_FAMILY = "agent.setup.first-kept";
export const BRANCH_DETAILS_FAMILY = "agent.entry.details";

export interface WorkerLifecycleOptions {
	harness: AgentHarness;
	session: Session;
	runner: ExtensionRunner;
	view: SessionView;
	context: Context;
	laneName?: string;
	onCompactionPointer?: (entryId: string, firstKeptEntryId: string) => void;
	onBranchSummaryDetails?: (entryId: string, details: JsonValue) => void;
	/** A caller preflight already emitted session_before_tree and applied admission options. */
	takeNavigationDecision?: () => WorkerNavigationDecision | undefined;
	callerOwnsNavigationEvents?: boolean;
}

function entryMessage(entry: Entry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "branch_summary") return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	return undefined;
}

function tailStart(entries: Entry[], tail: AgentMessage[]): string | undefined {
	if (!tail.length) return "";
	let index = tail.length - 1;
	for (let position = entries.length - 1; position >= 0; position -= 1) {
		const message = entryMessage(entries[position]);
		if (!message) continue;
		if (!isDeepStrictEqual(message, tail[index])) return undefined;
		if (index === 0) return entries[position].id;
		index -= 1;
	}
	return undefined;
}

function jsonDetails(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Compaction details are not JSON data");
	const decoded: unknown = JSON.parse(encoded);
	if (!isDeepStrictEqual(value, decoded))
		throw new Error("Compaction details contain values outside the durable JSON contract");
	return decoded as JsonValue;
}

/** Install structural hooks and message finalization on one lane. Dispose before the runner is replaced. */
export function installWorkerLifecycle(options: WorkerLifecycleOptions): () => void {
	const { harness, session, runner, view, context } = options;
	const laneName = options.laneName ?? "main";
	const remove: Array<() => void> = [];
	const compactedByExtension = new Map<string, boolean>();
	const navigatedByExtension = new Map<string, boolean>();
	const pendingPointers = new Map<string, string>();
	const pendingDetails = new Map<string, JsonValue>();
	const unsupported = (event: string, error: string) => {
		runner.emitError({ extensionPath: "<agent-host>", event, error });
		return { decline: true as const };
	};

	remove.push(
		harness.hooks.on("before_compaction", async (event, hookContext) => {
			if (event.lane !== laneName || !runner.hasHandlers("session_before_compact")) return undefined;
			const signal = hookContext.abortSignal;
			if (!signal) return unsupported("session_before_compact", "The operation hook supplied no abort signal");
			compactedByExtension.set(event.runId, false);
			const lane = await harness.lane(laneName, context);
			const entries = await lane.findEntries({ order: "oldestFirst" }, hookContext);
			const firstKeptEntryId = tailStart(entries, event.preparation.retainedTail);
			if (firstKeptEntryId === undefined)
				return unsupported(
					"session_before_compact",
					"The retained tail has no exact source-entry mapping; ordinary preparation.firstKeptEntryId is unavailable",
				);
			const preparation: SessionBeforeCompactEvent["preparation"] = {
				firstKeptEntryId,
				messagesToSummarize: event.preparation.messagesToSummarize,
				turnPrefixMessages: event.preparation.turnPrefixMessages,
				isSplitTurn: event.preparation.isSplitTurn,
				tokensBefore: event.preparation.tokensBefore,
				previousSummary: event.preparation.previousSummary,
				fileOps: event.preparation.fileOps,
				settings: event.preparation.settings,
			};
			const original = structuredClone(preparation);
			const result = await runner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: view.getBranch(),
				customInstructions: event.customInstructions,
				reason: event.reason,
				willRetry: event.reason === "overflow",
				signal,
			});
			if (result?.cancel) return { decline: true };
			if (!isDeepStrictEqual(preparation, original) && !(result && "compaction" in result && result.compaction))
				return unsupported(
					"session_before_compact",
					"The core compaction hook does not persist preparation mutations; return a complete compaction result instead",
				);
			if (!result || !("compaction" in result) || !result.compaction) return undefined;
			compactedByExtension.set(event.runId, true);
			const replacement = result.compaction;
			const start =
				replacement.firstKeptEntryId === ""
					? entries.length
					: entries.findIndex((entry) => entry.id === replacement.firstKeptEntryId);
			if (start < 0)
				return unsupported("session_before_compact", "The custom firstKeptEntryId is not on the current branch");
			let details: JsonValue | undefined;
			try {
				details = jsonDetails(replacement.details);
			} catch (error) {
				return unsupported("session_before_compact", error instanceof Error ? error.message : String(error));
			}
			pendingPointers.set(event.runId, replacement.firstKeptEntryId);
			return {
				compaction: {
					summary: replacement.summary,
					tokensBefore: replacement.tokensBefore,
					retainedTail: entries.slice(start).flatMap((entry) => {
						const message = entryMessage(entry);
						return message ? [message] : [];
					}),
					...(replacement.usage === undefined ? {} : { usage: replacement.usage }),
					...(details === undefined ? {} : { details }),
				},
			};
		}),
	);

	remove.push(
		harness.events.on("compaction_end", async (event) => {
			if (event.lane !== laneName) return;
			const fromExtension = compactedByExtension.get(event.runId) ?? false;
			compactedByExtension.delete(event.runId);
			const firstKeptEntryId = pendingPointers.get(event.runId);
			pendingPointers.delete(event.runId);
			if (event.status === "completed") {
				if (firstKeptEntryId !== undefined) {
					await session.mutate(async (mutator, mutationContext) => {
						await mutator.commit(
							[setValue(valueAddress<string>(COMPACTION_POINTER_FAMILY, event.entryId), firstKeptEntryId)],
							mutationContext,
						);
					}, context);
					options.onCompactionPointer?.(event.entryId, firstKeptEntryId);
				}
				const entry = view.getEntry(event.entryId);
				if (entry?.type !== "compaction") {
					unsupported("session_compact", "The completed compaction entry is absent from the session view");
					return;
				}
				await runner.emit({
					type: "session_compact",
					compactionEntry: firstKeptEntryId === undefined ? entry : { ...entry, firstKeptEntryId },
					fromExtension: entry.fromHook ?? fromExtension,
					reason: event.reason,
					willRetry: event.reason === "overflow",
				});
			} else {
				await runner.emit({
					type: "session_compact_failed",
					reason: event.reason,
					willRetry: event.reason === "overflow",
					fromExtension,
					aborted: event.status !== "failed",
					...(event.status === "failed" ? { errorMessage: event.error.message } : {}),
				});
			}
		}),
	);

	remove.push(
		harness.hooks.on("before_navigation", async (event, hookContext) => {
			if (event.lane !== laneName || (!options.takeNavigationDecision && !runner.hasHandlers("session_before_tree")))
				return undefined;
			const signal = hookContext.abortSignal;
			if (!signal) return unsupported("session_before_tree", "The operation hook supplied no abort signal");
			navigatedByExtension.set(event.runId, false);
			const oldLeafId = view.getLeafId();
			const selected = collectEntriesForBranchSummary(view, oldLeafId, event.targetId);
			const preparation: SessionBeforeTreeEvent["preparation"] = {
				targetId: event.targetId,
				oldLeafId,
				commonAncestorId: selected.commonAncestorId,
				entriesToSummarize: selected.entries,
				userWantsSummary: true,
				customInstructions: event.customInstructions,
			};
			const original = structuredClone(preparation);
			const result = options.takeNavigationDecision
				? options.takeNavigationDecision()
				: await runner.emit({ type: "session_before_tree", preparation, signal });
			if (result?.cancel) return { decline: true };
			if (!isDeepStrictEqual(preparation, original))
				return unsupported("session_before_tree", "The core navigation hook does not persist preparation mutations");
			if (
				result &&
				(("customInstructions" in result && result.customInstructions !== undefined) ||
					("replaceInstructions" in result && result.replaceInstructions !== undefined) ||
					("label" in result && result.label !== undefined))
			)
				return unsupported(
					"session_before_tree",
					"The core navigation hook cannot patch customInstructions, replaceInstructions, or label; apply these before lane acceptance",
				);
			if (!result || !("summary" in result) || !result.summary) return undefined;
			const modifiedFiles = [
				...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited]),
			].sort();
			let lists = {
				readFiles: [...event.preparation.fileOps.read].filter((file) => !modifiedFiles.includes(file)).sort(),
				modifiedFiles,
			};
			if (result.summary.details !== undefined) {
				let details: JsonValue | undefined;
				try {
					details = jsonDetails(result.summary.details);
				} catch (error) {
					return unsupported("session_before_tree", error instanceof Error ? error.message : String(error));
				}
				if (details !== undefined) pendingDetails.set(event.runId, details);
				const record = result.summary.details as Record<string, unknown> | null;
				if (
					record &&
					Array.isArray(record.readFiles) &&
					record.readFiles.every((file) => typeof file === "string") &&
					Array.isArray(record.modifiedFiles) &&
					record.modifiedFiles.every((file) => typeof file === "string")
				)
					lists = { readFiles: record.readFiles, modifiedFiles: record.modifiedFiles };
			}
			navigatedByExtension.set(event.runId, true);
			return {
				summary: {
					summary: result.summary.summary,
					...lists,
					...(result.summary.usage === undefined ? {} : { usage: result.summary.usage }),
				},
			};
		}),
	);

	remove.push(
		harness.events.on("navigation_end", async (event) => {
			if (event.lane !== laneName) return;
			const fromExtension = navigatedByExtension.get(event.runId) ?? false;
			navigatedByExtension.delete(event.runId);
			const details = pendingDetails.get(event.runId);
			pendingDetails.delete(event.runId);
			if (event.status !== "completed") return;
			if (details !== undefined && event.tipId) {
				await session.mutate(async (mutator, mutationContext) => {
					await mutator.commit(
						[setValue(valueAddress<JsonValue>(BRANCH_DETAILS_FAMILY, event.tipId!), details)],
						mutationContext,
					);
				}, context);
				options.onBranchSummaryDetails?.(event.tipId, details);
			}
			view.setLeafFromHarness(event.tipId);
			const entry = event.tipId ? view.getEntry(event.tipId) : undefined;
			if (options.callerOwnsNavigationEvents) return;
			await runner.emit({
				type: "session_tree",
				newLeafId: view.getLeafId(),
				oldLeafId: event.fromTipId,
				...(entry?.type === "branch_summary"
					? { summaryEntry: details === undefined ? entry : { ...entry, details } }
					: {}),
				fromExtension,
			});
		}),
	);

	remove.push(
		harness.hooks.on("after_response", async (event) => {
			if (event.lane !== laneName || !runner.hasHandlers("message_end")) return undefined;
			const replacement = await runner.emitMessageEnd({ type: "message_end", message: event.message });
			if (replacement?.role !== "assistant") return undefined;
			if (replacement.stopReason === "pending") {
				unsupported("message_end", "A finalized assistant message cannot change to pending");
				return undefined;
			}
			return { message: { ...replacement, stopReason: replacement.stopReason } };
		}),
	);
	remove.push(
		harness.events.on("message_end", async (event) => {
			if (event.lane !== laneName || event.message.role === "assistant" || !runner.hasHandlers("message_end")) return;
			const replacement = await runner.emitMessageEnd({ type: "message_end", message: event.message });
			if (replacement && !isDeepStrictEqual(replacement, event.message))
				unsupported(
					"message_end",
					`Core ${event.message.role} message_end is notification-only. before_run appends rather than replaces; after_tool does not expose the finalized toolResult message`,
				);
		}),
	);

	return () => {
		for (const dispose of remove.splice(0)) dispose();
		compactedByExtension.clear();
		navigatedByExtension.clear();
		pendingPointers.clear();
		pendingDetails.clear();
	};
}
