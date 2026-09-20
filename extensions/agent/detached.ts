/**
 * agent/detached: agent runs that outlive the session that started them.
 *
 * A durable agent session keeps its state on disk, but its execution belongs
 * to the process that owns the store. A detached run moves that execution into
 * its own operating-system process: the primary session starts it, releases
 * the session, and exits freely. The run keeps working and its result waits in
 * the durable session.
 *
 * The launcher publishes the request and process id atomically. The child
 * publishes progress and the terminal result after cleanup. A launch failure
 * produces a launcher-written result instead. Primary sessions acknowledge
 * reported outcomes in a separate marker. No result and no live process means
 * an abandoned run; these records do not provide cross-process session locks.
 */

import { openSync, closeSync, existsSync, mkdirSync, fstatSync, readSync, readdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";

/** Launcher-written description of one detached run. */
export interface DetachedRunRequest {
	runId: string;
	sessionId: string;
	sessionsRoot: string;
	agentDir: string;
	cwd: string;
	prompt: string;
	/** Project-trust decision resolved by the launcher; absent leaves the ordinary resolution to the run process. */
	trusted?: boolean;
	logFile: string;
	startedAt: string;
	/** Pending launch: launcher pid. Started launch: child pid. */
	pid: number;
	launchState: "pending" | "started";
}

/**
 * Run-process-written progress of one live detached run.
 *
 * The owner publishes bounded observations for record-based views and later
 * retrieval. Live control queries reach that same owner through its endpoint;
 * these retained records do not establish current endpoint or execution state.
 */
export interface DetachedRunProgress {
	runId: string;
	updatedAt: string;
	entryCount: number;
	/** Tool the run executes now; absent between tool calls. */
	currentTool?: string;
	/** Latest assistant text or tool line, bounded for chat display. */
	lastText?: string;
	error?: string;
}

/** Run-process-written outcome of one detached run. */
export interface DetachedRunResult {
	runId: string;
	state: "finished" | "failed";
	finishedAt: string;
	error?: string;
	/** Final assistant text of the run, bounded for chat display. */
	summary?: string;
}

/**
 * `launching`: no result, launch is pending, and the launcher answers.
 * `running`: no result, launch is complete, and the child process answers.
 * `abandoned`: no result and the process is gone (killed, crashed, or machine restart).
 */
export type DetachedRunState = "launching" | "running" | "finished" | "failed" | "abandoned";

export interface DetachedRunView extends DetachedRunRequest {
	state: DetachedRunState;
	finishedAt?: string;
	error?: string;
	summary?: string;
	/** Live progress of a running run; the last progress written by a settled run. */
	progress?: DetachedRunProgress;
	/** True once a primary session reported this run's outcome to the operator. */
	acknowledged?: boolean;
}

export type SpawnLike = (
	command: string,
	args: string[],
	options: { detached: boolean; stdio: Array<"ignore" | "pipe" | number>; env: NodeJS.ProcessEnv; cwd: string },
) => {
	pid?: number | undefined;
	unref(): void;
	stdin: { end(): void; on(event: "error", listener: (error: Error) => void): unknown } | null;
	kill(signal: NodeJS.Signals): boolean;
	on(event: "error", listener: (error: Error) => void): unknown;
	once(event: "spawn" | "exit", listener: () => void): unknown;
};

export const MAX_SUMMARY_CHARS = 600;

/** Liveness of a process id; a foreign-owner error still means the process exists. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The entry module a detached run executes. */
export function detachedRunEntry(): string {
	return fileURLToPath(new URL("./detached-run.ts", import.meta.url));
}

export class DetachedRuns {
	readonly root: string;

	constructor(storeRoot: string) {
		this.root = join(storeRoot, "detached");
	}

	requestFile(runId: string): string {
		return join(this.root, `${checkedRunId(runId)}.json`);
	}

	resultFile(runId: string): string {
		return join(this.root, `${checkedRunId(runId)}.result.json`);
	}

	progressFile(runId: string): string {
		return join(this.root, `${checkedRunId(runId)}.progress.json`);
	}

	seenFile(runId: string): string {
		return join(this.root, `${checkedRunId(runId)}.seen`);
	}

	logFile(runId: string): string {
		return join(this.root, `${checkedRunId(runId)}.log`);
	}

	writeRequest(request: DetachedRunRequest): void {
		if (!validRequest(request)) throw new Error("invalid detached request");
		mkdirSync(this.root, { recursive: true });
		writeJson(this.requestFile(request.runId), request, MAX_REQUEST_BYTES);
	}

	/** Atomic result publication: the reader never observes a half-written result. */
	writeResult(result: DetachedRunResult): void {
		if (!validResult(result, result.runId)) throw new Error("invalid detached result");
		mkdirSync(this.root, { recursive: true });
		writeJson(this.resultFile(result.runId), result, MAX_RECORD_BYTES);
	}

	/** Progress publication by the run process; the launcher never writes it. */
	writeProgress(progress: DetachedRunProgress): void {
		if (!validProgress(progress, progress.runId)) throw new Error("invalid detached progress");
		mkdirSync(this.root, { recursive: true });
		writeJson(this.progressFile(progress.runId), progress, MAX_RECORD_BYTES);
	}

	/** Record that the operator was told about this run's outcome. */
	acknowledge(runId: string): void {
		mkdirSync(this.root, { recursive: true });
		writeFileSync(this.seenFile(runId), `${new Date().toISOString()}\n`, "utf8");
	}

	get(runId: string): DetachedRunView | undefined {
		const request = readDetachedRequest(this.requestFile(runId));
		if (!request || request.runId !== runId) return undefined;
		const rawProgress = readJson(this.progressFile(runId), MAX_RECORD_BYTES);
		const progress = validProgress(rawProgress, runId) ? rawProgress : undefined;
		const acknowledged = existsSync(this.seenFile(runId));
		const common = {
			...request,
			...(progress?.runId ? { progress } : {}),
			...(acknowledged ? { acknowledged } : {}),
		};
		const result = readJson(this.resultFile(runId), MAX_RECORD_BYTES);
		if (validResult(result, runId)) {
			return {
				...common,
				state: result.state,
				finishedAt: result.finishedAt,
				...(result.error ? { error: result.error } : {}),
				...(result.summary ? { summary: result.summary } : {}),
			};
		}
		return { ...common, state: isProcessAlive(request.pid) ? request.launchState === "pending" ? "launching" : "running" : "abandoned" };
	}

	/** Every known run, newest start first. */
	list(): DetachedRunView[] {
		let names: string[];
		try {
			names = readdirSync(this.root);
		} catch {
			return [];
		}
		const runs: DetachedRunView[] = [];
		for (const name of names) {
			if (!name.endsWith(".json") || name.endsWith(".result.json") || name.endsWith(".progress.json")) continue;
			const runId = name.slice(0, -".json".length);
			if (!validRunId(runId)) continue;
			const view = this.get(runId);
			if (view) runs.push(view);
		}
		return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
	}

	/** The run that currently owns a session's execution, if any. */
	liveFor(sessionId: string): DetachedRunView | undefined {
		return this.list().find((run) => run.sessionId === sessionId && (run.state === "running" || run.state === "launching"));
	}

	/**
	 * Start one detached run and return its request record.
	 *
	 * The child is detached and unreferenced, so this process exits without
	 * stopping it. Its output goes to the run log, because a detached process
	 * has no terminal to write to.
	 */
	async start(options: {
		runId: string;
		sessionId: string;
		sessionsRoot: string;
		agentDir: string;
		cwd: string;
		prompt: string;
		trusted?: boolean;
		spawn?: SpawnLike;
		entry?: string;
	}): Promise<DetachedRunRequest> {
		mkdirSync(this.root, { recursive: true });
		const logFile = this.logFile(options.runId);
		const request: DetachedRunRequest = {
			runId: options.runId,
			sessionId: options.sessionId,
			sessionsRoot: options.sessionsRoot,
			agentDir: options.agentDir,
			cwd: options.cwd,
			prompt: options.prompt,
			...(options.trusted === undefined ? {} : { trusted: options.trusted }),
			logFile,
			startedAt: new Date().toISOString(),
			pid: process.pid,
			launchState: "pending",
		};
		// The request file is the child's only input, so it exists before the
		// child starts. The process id is added once the child has one; the
		// launcher is the only writer of this file either way.
		if (existsSync(this.requestFile(options.runId))) throw new Error(`detached run already exists: ${options.runId}`);
		this.writeRequest(request);
		let child: ReturnType<SpawnLike> | undefined;
		let spawned = false;
		let log: number | undefined;
		try {
			log = openSync(logFile, "a");
			child = (options.spawn ?? (spawnProcess as unknown as SpawnLike))(
				process.execPath,
				[options.entry ?? detachedRunEntry(), this.requestFile(options.runId)],
				{
					detached: true,
					stdio: ["pipe", log, log],
					env: {
						...process.env,
						PI_AGENT_SESSIONS_DIR: options.sessionsRoot,
						PI_AGENT_DIR: options.agentDir,
					},
					cwd: options.cwd,
				},
			);
			const launched = child;
			const pid = await new Promise<number>((resolve, reject) => {
				// Keep the error listener after spawn so late process errors never
				// become uncaught EventEmitter errors. Only launch failure rejects.
				launched.on("error", reject);
				launched.stdin?.on("error", reject);
				launched.once("spawn", () => {
					spawned = true;
					const pid = launched.pid;
					if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) reject(new Error("detached process has no valid pid"));
					else resolve(pid);
				});
			});
			if (!child.stdin) throw new Error("detached process has no launch input");
			request.pid = pid;
			request.launchState = "started";
			this.writeRequest(request);
			child.stdin.end();
			child.unref();
			return request;
		} catch (error) {
			if (spawned && child?.pid) {
				const processToStop = child;
				await new Promise<void>((resolve) => {
					processToStop.once("exit", resolve);
					if (!processToStop.kill("SIGTERM")) resolve();
				});
			}
			this.writeResult({ runId: request.runId, state: "failed", finishedAt: new Date().toISOString(),
				error: `launch failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000) });
			throw error;
		} finally {
			if (log !== undefined) closeSync(log);
		}
	}
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;

function validRunId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value);
}

function checkedRunId(value: string): string {
	if (!validRunId(value)) throw new Error("invalid detached run id");
	return value;
}

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalText(value: unknown, max: number): boolean {
	return value === undefined || text(value, max);
}

function timestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validRequest(value: unknown): value is DetachedRunRequest {
	return record(value, ["runId", "sessionId", "sessionsRoot", "agentDir", "cwd", "prompt", "trusted", "logFile", "startedAt", "pid", "launchState"])
		&& validRunId(value.runId) && text(value.sessionId, 256)
		&& [value.sessionsRoot, value.agentDir, value.cwd, value.logFile].every((path) => text(path, 4096))
		&& text(value.prompt, MAX_REQUEST_BYTES) && timestamp(value.startedAt)
		&& (value.trusted === undefined || typeof value.trusted === "boolean")
		&& Number.isSafeInteger(value.pid) && (value.pid as number) >= 0
		&& (value.launchState === "pending" || value.launchState === "started");
}

function validProgress(value: unknown, runId: string): value is DetachedRunProgress {
	return record(value, ["runId", "updatedAt", "entryCount", "currentTool", "lastText", "error"])
		&& validRunId(value.runId) && value.runId === runId && timestamp(value.updatedAt)
		&& Number.isSafeInteger(value.entryCount) && (value.entryCount as number) >= 0
		&& optionalText(value.currentTool, 256) && optionalText(value.lastText, MAX_SUMMARY_CHARS) && optionalText(value.error, 2000);
}

function validResult(value: unknown, runId: string): value is DetachedRunResult {
	return record(value, ["runId", "state", "finishedAt", "error", "summary"])
		&& validRunId(value.runId) && value.runId === runId && timestamp(value.finishedAt)
		&& (value.state === "finished" || value.state === "failed")
		&& (value.state === "finished" ? value.error === undefined : text(value.error, 2000))
		&& optionalText(value.summary, MAX_SUMMARY_CHARS);
}

/** Bounded current-shape request read; invalid records never become execution input. */
export function readDetachedRequest(path: string): DetachedRunRequest | undefined {
	const value = readJson(path, MAX_REQUEST_BYTES);
	return validRequest(value) ? value : undefined;
}

function readJson(path: string, maxBytes: number): unknown {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) return undefined;
		const buffer = Buffer.alloc(maxBytes + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (!count) break;
			bytes += count;
		}
		return bytes <= maxBytes ? JSON.parse(buffer.toString("utf8", 0, bytes)) : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeJson(path: string, value: unknown, maxBytes: number): void {
	const body = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(body) > maxBytes) throw new Error("detached record exceeds byte limit");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); } catch (cleanup) {
			if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanup], "detached publication and cleanup failed");
		}
		throw error;
	}
}

/** Operator-facing description of a run: what it is doing now, or what it did. */
export function formatRun(run: DetachedRunView): string {
	const detail = run.state === "finished" || run.state === "failed" ? ` finished=${run.finishedAt}` : ` pid=${run.pid}`;
	const lines = [`${run.runId}  ${run.state}  session=${run.sessionId}  started=${run.startedAt}${detail}`];
	if (run.state === "running" && run.progress) {
		lines.push(
			`    entries=${run.progress.entryCount}${run.progress.currentTool ? `  tool=${run.progress.currentTool}` : ""}  updated=${run.progress.updatedAt}`,
		);
		if (run.progress.lastText) lines.push(`    ${oneLine(run.progress.lastText)}`);
	} else if (run.state === "running") {
		lines.push("    no progress record yet");
	}
	if (run.error) lines.push(`    error=${oneLine(run.error)}`);
	else if (run.summary) lines.push(`    ${oneLine(run.summary)}`);
	if (run.state === "abandoned") lines.push("    the process is gone; completed work remains; a retained writer claim blocks reopening");
	return lines.join("\n");
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS)}…` : flat;
}
