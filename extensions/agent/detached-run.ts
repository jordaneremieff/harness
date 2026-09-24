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

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { ProjectTrustStore, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { DetachedRuns, MAX_SUMMARY_CHARS, readDetachedRequest, type DetachedRunProgress, type DetachedRunRequest } from "./detached.ts";
import { createDetachedControlServer } from "./detached-control.ts";
import { AgentManager, createAgentModelRuntime } from "./index.ts";
import { AgentStore } from "./store.ts";
import type { AgentWorkerSession, WorkerObservation } from "./worker.ts";

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

/** Native session events supply transient execution state; SessionManager supplies stored text. */
export function progressRecord(
	runId: string,
	entries: SessionEntry[],
	operation: WorkerObservation | null,
	error?: string,
): Omit<DetachedRunProgress, "updatedAt"> {
	const tool = operation?.currentTool;
	const lastText = operation?.lastText || progressText(entries);
	return {
		runId,
		entryCount: entries.length,
		...(tool ? { currentTool: tool } : {}),
		...(lastText ? { lastText: lastText.slice(0, MAX_SUMMARY_CHARS) } : {}),
		...(error ? { error: error.slice(0, 2000) } : {}),
	};
}

/** Coalesce updates into one write per window; final publication cancels pending work. */
export function createProgressWriter(
	readProgress: () => Omit<DetachedRunProgress, "updatedAt">,
	writeProgress: (progress: DetachedRunProgress) => void,
	now: () => number = Date.now,
): (final?: boolean, immediate?: boolean) => void {
	let lastWrite = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	return function publishProgress(final = false, immediate = false): void {
		if (closed) return;
		const time = now();
		const remaining = 500 - (time - lastWrite);
		if (!final && !immediate && remaining > 0) {
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

type DetachedWorker = Pick<AgentWorkerSession, "setOnUpdate" | "observe" | "observation" | "start" | "waitForIdle" | "lastErrorMessage" | "operationResult" | "abort" | "status" | "inspect" | "steer" | "sessionMetadata" | "compact" | "runCommand"> & {
	sessionManager(): { getEntries(): SessionEntry[] };
};

interface DetachedHost {
	open(): Promise<DetachedWorker>;
	close(): Promise<void>;
	activeHostedSessionIds?(): string[];
}

async function createDetachedHost(request: DetachedRunRequest): Promise<DetachedHost> {
	const store = new AgentStore({ sessionsRoot: request.sessionsRoot });
	try {
		const manager = new AgentManager(store, await createAgentModelRuntime({ authPath: join(request.agentDir, "auth.json"), modelsPath: join(request.agentDir, "models.json") }), new ProjectTrustStore(request.agentDir), undefined, request.agentDir);
		return {
			open: () => manager.openDetachedRun(request.runId, request.sessionId, request.trusted),
			activeHostedSessionIds: () => manager.activeSessionIds(),
			close: async () => {
				await manager.closeAll();
				await store.close(BACKGROUND_CONTEXT);
			},
		};
	} catch (error) {
		await store.close(BACKGROUND_CONTEXT);
		throw error;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function operationFailure(operationId: string | undefined, result: Awaited<ReturnType<DetachedWorker["operationResult"]>>, previous: string | undefined): string | undefined {
	if (operationId && !result) return previous ?? "admitted operation has no terminal result";
	if (result && result.status !== "completed") return previous ?? (result.error?.message || `operation ${result.status}`);
	return previous;
}

/** Report hosted sessions still working at close; undefined when none or unavailable. */
function hostedWorkFailure(host: DetachedHost | undefined): string | undefined {
	try {
		const hosted = host?.activeHostedSessionIds?.() ?? [];
		return hosted.length ? `hosted sessions closed with active work: ${hosted.join(", ")}; their in-flight turns are aborted` : undefined;
	} catch (error) { return `hosted session inspection failed: ${errorText(error)}`; }
}

/** Cancellation requests native session abort; terminal publication follows host cleanup. */
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
		() => ({ ...progressRecord(request.runId, worker?.sessionManager().getEntries() ?? [], settled ? null : worker?.observation() ?? null, failure), ...(worker ? { currentSessionId: worker.sessionMetadata().id } : {}) }),
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
			...(worker ? { currentSessionId: worker.sessionMetadata().id } : {}),
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
	async function cleanupRun(): Promise<void> {
		try { await seal(); } catch (error) {
			const detail = errorText(error);
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
		try { await control?.close(); } catch (error) { addFailure(`control cleanup failed: ${errorText(error)}`); }
		const hostedFailure = hostedWorkFailure(host);
		if (hostedFailure) addFailure(hostedFailure);
		try { await host?.close(); } catch (error) { addFailure(`cleanup failed: ${errorText(error)}`); }
		options.signal?.removeEventListener("abort", stopFromSignal);
	}
	try {
		stopping.signal.throwIfAborted();
		host = await (options.createHost ?? createDetachedHost)(request);
		worker = await host.open();
		stopping.signal.throwIfAborted();
		// WorkerUpdate carries stored entries, not tool execution state.
		worker.setOnUpdate((update) => {
			if (update.kind === "error") failure ??= update.message;
			publishProgress(false, update.kind === "replaced");
		});
		unsubscribe = worker.observe(() => publishProgress());
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
		const finalSnapshot = worker.observation();
		const result = operationId ? await worker.operationResult(operationId) : undefined;
		failure = operationFailure(operationId, result, failure);
		failure ??= worker.lastErrorMessage();
		if (finalSnapshot.pending) {
			addFailure(`${finalSnapshot.pending} queued messages remain unconsumed; ordinary queues do not survive process exit`);
		}
	} catch (error) {
		failure ??= error instanceof Error ? error.message : String(error);
	} finally {
		await cleanupRun();
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
	if (!requestPath || request?.launchState !== "started" || request.pid !== process.pid
		|| resolve(requestPath) !== resolve(new DetachedRuns(request.sessionsRoot).requestFile(request.runId))) {
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
