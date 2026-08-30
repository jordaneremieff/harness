import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { createBoundedFileSink, type BoundedFileResult, type BoundedFileSink } from "./bounded-file.mts";

export type CancellationReason = "watchdog" | "parent_signal" | "io_error";

export interface ManagedChildOutcome {
	pid?: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: string;
	cancellation?: CancellationReason;
	terminationSignals: NodeJS.Signals[];
	stdout: BoundedFileResult;
	stderr: BoundedFileResult;
}

interface ManagedChildOptions {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdoutPath: string;
	stderrPath: string;
	maxOutputBytes: number;
	watchdogMs: number;
	terminationGraceMs: number;
	killWaitMs: number;
	signal?: AbortSignal;
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function runManagedChild(options: ManagedChildOptions): Promise<ManagedChildOutcome> {
	const stdoutSink = createBoundedFileSink(options.stdoutPath, options.maxOutputBytes);
	let stderrSink: BoundedFileSink;
	try {
		stderrSink = createBoundedFileSink(options.stderrPath, options.maxOutputBytes);
	} catch (error) {
		stdoutSink.close();
		throw error;
	}
	return new Promise((resolveOutcome) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(options.executable, options.args, {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				detached: process.platform !== "win32",
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolveOutcome({
				exitCode: null,
				signal: null,
				spawnError: errorText(error),
				terminationSignals: [],
				stdout: stdoutSink.close(),
				stderr: stderrSink.close(),
			});
			return;
		}
		let settled = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let spawnError: string | undefined;
		let cancellation: CancellationReason | undefined;
		let ioError: string | undefined;
		const terminationSignals: NodeJS.Signals[] = [];
		let graceTimer: NodeJS.Timeout | undefined;
		let hardTimer: NodeJS.Timeout | undefined;

		const send = (signal: NodeJS.Signals): void => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-child.pid, signal);
				terminationSignals.push(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") ioError ??= `termination failed: ${errorText(error)}`;
			}
		};
		const finish = (hardStop = false): void => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdogTimer);
			if (graceTimer) clearTimeout(graceTimer);
			if (hardTimer) clearTimeout(hardTimer);
			options.signal?.removeEventListener("abort", abortListener);
			if (hardStop) {
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
			}
			let stdout: BoundedFileResult = { path: options.stdoutPath, bytes: 0, truncated: false };
			let stderr: BoundedFileResult = { path: options.stderrPath, bytes: 0, truncated: false };
			try {
				stdout = stdoutSink.close();
			} catch (error) {
				ioError ??= `stdout sink failed: ${errorText(error)}`;
			}
			try {
				stderr = stderrSink.close();
			} catch (error) {
				ioError ??= `stderr sink failed: ${errorText(error)}`;
			}
			resolveOutcome({
				pid: child.pid,
				exitCode,
				signal: exitSignal,
				...((spawnError ?? ioError) ? { spawnError: spawnError ?? ioError } : {}),
				...(cancellation ? { cancellation } : {}),
				terminationSignals,
				stdout,
				stderr,
			});
		};
		function cancel(reason: CancellationReason): void {
			if (settled || cancellation !== undefined) return;
			cancellation = reason;
			send("SIGTERM");
			graceTimer = setTimeout(() => send("SIGKILL"), options.terminationGraceMs);
			hardTimer = setTimeout(() => finish(true), options.terminationGraceMs + options.killWaitMs);
		}
		const consume = (stream: Readable | null, sink: BoundedFileSink, label: string): void => {
			stream?.on("data", (chunk: Buffer) => {
				try {
					sink.accept(chunk);
				} catch (error) {
					ioError ??= `${label} sink failed: ${errorText(error)}`;
					cancel("io_error");
				}
			});
			stream?.once("error", (error) => {
				ioError ??= `${label} stream failed: ${errorText(error)}`;
				cancel("io_error");
			});
		};
		consume(child.stdout, stdoutSink, "stdout");
		consume(child.stderr, stderrSink, "stderr");
		const abortListener = (): void => cancel("parent_signal");
		const watchdogTimer = setTimeout(() => cancel("watchdog"), options.watchdogMs);
		options.signal?.addEventListener("abort", abortListener, { once: true });
		child.once("error", (error) => {
			spawnError = errorText(error);
		});
		child.once("close", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			if (cancellation !== undefined && process.platform !== "win32") return;
			finish();
		});
		if (options.signal?.aborted) cancel("parent_signal");
	});
}
