/**
 * agent/detached-run: the process that executes one detached agent run.
 *
 * It is started by the launcher in `detached.ts` with one argument: the path
 * of the run request. It opens the durable session, runs the prompt to
 * completion, and publishes one result record. It owns the session's execution
 * for its lifetime, which is why the launcher releases the session first.
 *
 * This module is a process entry point, not part of the extension surface. It
 * is executed by Node directly and registers nothing with Pi.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, reduceLaneSnapshot, type HarnessEvent, type LaneSnapshot } from "@earendil-works/pi-agent-core";
import { ProjectTrustStore, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { DetachedRuns, MAX_SUMMARY_CHARS, readDetachedRequest, type DetachedRunProgress, type DetachedRunRequest } from "./detached.ts";
import { createDetachedControlServer } from "./detached-control.ts";
import { AgentManager, createAgentModelRuntime } from "./index.ts";
import { AgentStore } from "./store.ts";
import type { AgentWorkerSession } from "./worker.ts";

/** Latest durable assistant text or tool line, without guesses about tool execution. */
export function progressText(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		const text = message.content.map((part) => part.type === "text" ? part.text : "").join("").trim();
		if (message.role === "toolResult") return `${message.toolName}: ${text}`.trim().slice(0, MAX_SUMMARY_CHARS);
		if (text) return text.slice(0, MAX_SUMMARY_CHARS);
	}
	return undefined;
}

/** Execution state comes from the lane; durable text and counts come from the session view. */
export function progressRecord(
	runId: string,
	entries: SessionEntry[],
	operation: LaneSnapshot["operation"],
	error?: string,
): Omit<DetachedRunProgress, "updatedAt"> {
	const tool = operation?.runningTools.find((candidate) => candidate.status === "running");
	const content = tool?.result?.content ?? operation?.streamingMessage?.content;
	const text = content?.map((part) => part.type === "text" ? part.text : "").join("").trim();
	const lastText = tool ? `${tool.toolName}${text ? `: ${text}` : ""}` : text || progressText(entries);
	return {
		runId,
		entryCount: entries.length,
		...(tool ? { currentTool: tool.toolName } : {}),
		...(lastText ? { lastText: lastText.slice(0, MAX_SUMMARY_CHARS) } : {}),
		...(error ? { error: error.slice(0, 2000) } : {}),
	};
}

/** Coalesce updates into one write per window; final publication cancels pending work. */
export function createProgressWriter(
	readProgress: () => Omit<DetachedRunProgress, "updatedAt">,
	writeProgress: (progress: DetachedRunProgress) => void,
	now: () => number = Date.now,
): (final?: boolean) => void {
	let lastWrite = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	return function publishProgress(final = false): void {
		if (closed) return;
		const time = now();
		const remaining = 500 - (time - lastWrite);
		if (!final && remaining > 0) {
			timer ??= setTimeout(() => { timer = undefined; publishProgress(); }, remaining);
			return;
		}
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (final) closed = true;
		writeProgress({ ...readProgress(), updatedAt: new Date(time).toISOString() });
		lastWrite = time;
	};
}

function finalAssistantText(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("")
			.trim();
		if (text) return text.slice(0, MAX_SUMMARY_CHARS);
	}
	return undefined;
}

type DetachedWorker = Pick<AgentWorkerSession, "setOnUpdate" | "observeLane" | "start" | "waitForIdle" | "lastErrorMessage" | "operationResult" | "abort" | "status" | "inspect" | "steer" | "sessionMetadata"> & {
	sessionManager(): { getEntries(): SessionEntry[] };
};

interface DetachedHost {
	open(): Promise<DetachedWorker>;
	close(): Promise<void>;
}

async function createDetachedHost(request: DetachedRunRequest): Promise<DetachedHost> {
	const store = new AgentStore({ sessionsRoot: request.sessionsRoot });
	try {
		const manager = new AgentManager(store, await createAgentModelRuntime(), new ProjectTrustStore(request.agentDir), undefined, request.agentDir);
		return {
			open: () => manager.openDetachedRun(request.runId, request.sessionId, request.trusted),
			close: async () => {
				try { await manager.closeAll(); } finally { await store.close(BACKGROUND_CONTEXT); }
			},
		};
	} catch (error) {
		await store.close(BACKGROUND_CONTEXT);
		throw error;
	}
}

/** Cancellation requests lane abort; terminal publication follows host cleanup. */
export async function executeDetachedRun(
	request: DetachedRunRequest,
	options: {
		signal?: AbortSignal;
		createHost?: (request: DetachedRunRequest) => Promise<DetachedHost>;
		createControlServer?: typeof createDetachedControlServer;
	} = {},
): Promise<number> {
	const runs = new DetachedRuns(request.sessionsRoot);
	let host: DetachedHost | undefined;
	let worker: DetachedWorker | undefined;
	let snapshot: LaneSnapshot | undefined;
	let control: Awaited<ReturnType<typeof createDetachedControlServer>> | undefined;
	let sealTask: Promise<void> | undefined;
	let admissionComplete = false;
	let failure: string | undefined;
	let settled = false;
	const addFailure = (message: string): void => {
		failure = failure === undefined ? message : `${failure}; ${message}`;
	};
	const seal = (): Promise<void> => {
		admissionComplete = false;
		sealTask ??= control?.sealAndDrain() ?? Promise.resolve();
		return sealTask;
	};
	let unsubscribe: (() => void) | undefined;
	const publishProgress = createProgressWriter(
		() => progressRecord(request.runId, worker?.sessionManager().getEntries() ?? [], settled ? null : snapshot?.operation ?? null, failure),
		(progress) => runs.writeProgress(progress),
	);
	const finish = (state: "finished" | "failed", detail: { error?: string; summary?: string }): number => {
		settled = true;
		failure = detail.error ?? failure;
		unsubscribe?.();
		unsubscribe = undefined;
		publishProgress(true);
		runs.writeResult({
			runId: request.runId,
			state,
			finishedAt: new Date().toISOString(),
			...(state === "failed" ? { error: (detail.error || "detached run failed").slice(0, 2000) } : {}),
			...(detail.summary ? { summary: detail.summary } : {}),
		});
		return state === "finished" ? 0 : 1;
	};
	const stopping = new AbortController();
	let abortTask: Promise<unknown> | undefined;
	const abortWorker = (): void => {
		abortTask ??= worker?.abort().catch((error: unknown) => { addFailure(`abort failed: ${String(error)}`); });
	};
	const stop = (reason: unknown): void => {
		if (stopping.signal.aborted) return;
		stopping.abort(reason);
		addFailure(reason instanceof Error ? reason.message : "run stopped");
		abortWorker();
	};
	const stopFromSignal = (): void => stop(options.signal?.reason);
	options.signal?.addEventListener("abort", stopFromSignal, { once: true });
	if (options.signal?.aborted) stopFromSignal();
	let priorEntries: Set<string> | undefined;
	let summary: string | undefined;
	try {
		stopping.signal.throwIfAborted();
		host = await (options.createHost ?? createDetachedHost)(request);
		worker = await host.open();
		stopping.signal.throwIfAborted();
		// WorkerUpdate carries stored entries, not tool execution state.
		worker.setOnUpdate((update) => {
			if (update.kind === "error") failure ??= update.message;
			publishProgress();
		});
		const observer = await worker.observeLane();
		snapshot = observer.snapshot;
		let heldEvents: HarnessEvent[] | undefined;
		const receive = (event: HarnessEvent): void => {
			if (settled || !snapshot) return;
			if (heldEvents) { heldEvents.push(event); return; }
			if (reduceLaneSnapshot(snapshot, event) === "rebase") {
				heldEvents = [];
				void observer.resnapshot().then((next) => {
					if (settled) return;
					snapshot = next;
					const events = heldEvents ?? [];
					heldEvents = undefined;
					for (const held of events) receive(held);
					publishProgress();
				}).catch((error: unknown) => {
					if (settled) return;
					heldEvents = undefined;
					failure ??= error instanceof Error ? error.message : String(error);
					publishProgress();
				});
				return;
			}
			if (event.type === "run_end") failure ??= snapshot.lastResult?.error?.message;
			publishProgress();
		};
		unsubscribe = observer.subscribe(receive);
		publishProgress();
		control = await (options.createControlServer ?? createDetachedControlServer)({
			request, worker, metadata: worker.sessionMetadata(),
			requestAbort: () => { stop(new Error("run stopped by remote abort")); return true; },
			canSteer: () => admissionComplete && !stopping.signal.aborted,
		});
		stopping.signal.throwIfAborted();
		priorEntries = new Set(worker.sessionManager().getEntries().map((entry) => entry.id));
		const operationId = await worker.start(request.prompt);
		admissionComplete = true;
		// Abort before admission can find no operation. The sticky run request
		// also applies to the operation that admission subsequently creates.
		if (stopping.signal.aborted) { await abortTask; abortTask = undefined; abortWorker(); }
		await worker.waitForIdle();
		await seal();
		await worker.waitForIdle();
		const finalSnapshot = await observer.resnapshot();
		const result = operationId ? await worker.operationResult(operationId) : undefined;
		if (operationId && !result) failure ??= "admitted operation has no terminal result";
		else if (result && result.status !== "completed") failure ??= result.error?.message || `operation ${result.status}`;
		failure ??= worker.lastErrorMessage();
		if (finalSnapshot.queues.length) {
			addFailure(`${finalSnapshot.queues.length} queued input entries remain unconsumed; durable input is retained`);
		}
	} catch (error) {
		failure ??= error instanceof Error ? error.message : String(error);
	} finally {
		try { await seal(); } catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (failure !== detail) addFailure(`control drain failed: ${detail}`);
		}
		settled = true;
		unsubscribe?.();
		unsubscribe = undefined;
		worker?.setOnUpdate(undefined);
		await abortTask;
		if (worker && priorEntries) {
			const previous = priorEntries;
			summary = finalAssistantText(worker.sessionManager().getEntries().filter((entry) => !previous.has(entry.id)));
		}
		try { await control?.close(); } catch (error) {
			addFailure(`control cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try { await host?.close(); } catch (error) {
			addFailure(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		options.signal?.removeEventListener("abort", stopFromSignal);
	}
	return failure !== undefined
		? finish("failed", { error: failure, ...(summary ? { summary } : {}) })
		: finish("finished", { ...(summary ? { summary } : {}) });
}

async function main(): Promise<number> {
	// EOF releases the child only after the launcher publishes its pid. A
	// launcher that exits early leaves a pending record, which fails below.
	await new Promise<void>((resolve, reject) => {
		process.stdin.once("end", resolve);
		process.stdin.once("error", reject);
		process.stdin.resume();
	});
	const requestPath = process.argv[2];
	const request = requestPath ? readDetachedRequest(requestPath) : undefined;
	if (request?.launchState !== "started" || request.pid !== process.pid
		|| resolve(requestPath!) !== resolve(new DetachedRuns(request.sessionsRoot).requestFile(request.runId))) {
		process.stderr.write("agent detached run requires a valid request at its run path\n");
		return 2;
	}
	const abort = new AbortController();
	const stopTerm = () => abort.abort(new Error("run stopped by SIGTERM"));
	const stopInt = () => abort.abort(new Error("run stopped by SIGINT"));
	process.on("SIGTERM", stopTerm);
	process.on("SIGINT", stopInt);
	try { return await executeDetachedRun(request, { signal: abort.signal }); } finally {
		process.off("SIGTERM", stopTerm);
		process.off("SIGINT", stopInt);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
