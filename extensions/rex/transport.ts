import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type TransportOutcome = "exited" | "timeout" | "cancelled" | "output_limit" | "spawn_error";
export interface CliResult {
	outcome: TransportOutcome;
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	bytes: number;
	truncated: boolean;
	started: boolean;
}
export interface CliCall {
	signal?: AbortSignal;
	finaliseSignal?: AbortSignal;
	timeoutMs: number;
	maxOutputBytes: number;
	stdin?: string;
	cwd?: string;
	onLine?: (line: string) => void;
}
export interface RexTransport {
	run(args: readonly string[], call: CliCall): Promise<CliResult>;
	dispose(): void;
}

/** Each process belongs to one call. Terminal programs belong to Rex, not this process group. */
export class CliTransport implements RexTransport {
	private readonly active = new Set<AbortController>();
	private disposed = false;
	private readonly executable: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly maxActive: number;
	constructor(executable = "rex", env: NodeJS.ProcessEnv = process.env, maxActive = 8) {
		this.executable = executable;
		this.env = env;
		this.maxActive = maxActive;
	}

	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		if (this.disposed || call.signal?.aborted || call.finaliseSignal?.aborted) return empty("cancelled");
		if (this.active.size >= this.maxActive)
			return { ...empty("spawn_error"), stderr: "Rex CLI concurrency limit reached." };
		if (
			!Number.isSafeInteger(call.timeoutMs) ||
			call.timeoutMs < 1 ||
			call.timeoutMs > 600000 ||
			!Number.isSafeInteger(call.maxOutputBytes) ||
			call.maxOutputBytes < 1024 ||
			call.maxOutputBytes > 1048576
		) {
			throw new Error("Rex CLI bounds are invalid.");
		}
		// The caller's timeout covers the whole call, including termination and forced settlement.
		const finalCutoff = performance.now() + call.timeoutMs;
		const reserve = Math.min(1000, Math.max(1, Math.floor(call.timeoutMs / 10)));
		const executionCutoff = finalCutoff - reserve;
		const abort = new AbortController();
		const relay = () => abort.abort();
		call.signal?.addEventListener("abort", relay, { once: true });
		this.active.add(abort);
		try {
			return await new Promise<CliResult>((resolve) => {
				let child: ReturnType<typeof spawn>;
				let outcome: TransportOutcome = "exited";
				let stdout = "";
				let stderr = "";
				let bytes = 0;
				let truncated = false;
				let started = false;
				let settled = false;
				let lineBuffer = "";
				const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
				let deadline: ReturnType<typeof setTimeout> | undefined;
				let escalation: ReturnType<typeof setTimeout> | undefined;
				let forced: ReturnType<typeof setTimeout> | undefined;
				const kill = (signal: NodeJS.Signals) => {
					if (!child?.pid) return;
					try {
						process.kill(-child.pid, signal);
					} catch {
						try {
							child.kill(signal);
						} catch {
							/* Already gone. */
						}
					}
				};
				const after = (at: number, action: () => void) =>
					setTimeout(action, Math.max(0, at - performance.now()));
				const finish = (exitCode: number | null, signal: string | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(deadline);
					clearTimeout(escalation);
					clearTimeout(forced);
					abort.signal.removeEventListener("abort", onAbort);
					call.finaliseSignal?.removeEventListener("abort", onFinalise);
					if (!truncated) {
						stdout += decoders.stdout.end();
						stderr += decoders.stderr.end();
					}
					child?.stdin?.destroy();
					child?.stdout?.destroy();
					child?.stderr?.destroy();
					resolve({ outcome, exitCode, signal, stdout, stderr, bytes, truncated, started });
				};
				const stop = (reason: TransportOutcome) => {
					if (settled || outcome !== "exited") return;
					outcome = reason;
					kill("SIGTERM");
					const termAt = performance.now();
					escalation = after(Math.min(termAt + 250, finalCutoff), () => kill("SIGKILL"));
					forced = after(finalCutoff, () => finish(null, "SIGKILL"));
				};
				const onAbort = () => stop("cancelled");
				const onFinalise = () => {
					if (settled) return;
					if (outcome === "exited") outcome = "cancelled";
					kill("SIGKILL");
					finish(null, "SIGKILL");
				};
				const emitLines = (text: string) => {
					if (!call.onLine) return;
					lineBuffer += text;
					for (;;) {
						const newline = lineBuffer.indexOf("\n");
						if (newline < 0) return;
						const line = lineBuffer.slice(0, newline);
						lineBuffer = lineBuffer.slice(newline + 1);
						try {
							call.onLine(line);
						} catch {
							stop("output_limit");
							return;
						}
					}
				};
				const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
					if (settled) return;
					const remaining = Math.max(0, call.maxOutputBytes - bytes);
					bytes += chunk.length;
					const accepted = chunk.subarray(0, remaining);
					const text = decoders[stream].write(accepted);
					if (stream === "stdout") {
						stdout += text;
						emitLines(text);
					} else stderr += text;
					if (chunk.length > remaining) {
						truncated = true;
						stop("output_limit");
					}
				};
				// Ambient resource IDs never choose targets inside an explicitly built CLI request.
				const env = { ...this.env };
				delete env.REX_SESSION;
				delete env.REX_BLOCK;
				delete env.REX_CLIENT;
				delete env.REX_SERVER;
				call.finaliseSignal?.addEventListener("abort", onFinalise, { once: true });
				deadline = after(executionCutoff, () => stop("timeout"));
				try {
					child = spawn(this.executable, [...args], {
						cwd: call.cwd,
						env,
						shell: false,
						detached: true,
						stdio: ["pipe", "pipe", "pipe"],
					});
					child.once("spawn", () => {
						started = true;
						if (abort.signal.aborted) stop("cancelled");
					});
					child.stdout?.on("data", (chunk: Buffer) => consume("stdout", chunk));
					child.stderr?.on("data", (chunk: Buffer) => consume("stderr", chunk));
					child.once("error", (error) => {
						stderr = error.message.slice(0, 1024);
						if (outcome === "exited") outcome = "spawn_error";
						finish(null, null);
					});
					child.once("close", finish);
					child.stdin?.on("error", () => {
						/* EPIPE is reflected in the CLI result. */
					});
					child.stdin?.end(call.stdin);
					abort.signal.addEventListener("abort", onAbort, { once: true });
					if (call.finaliseSignal?.aborted) onFinalise();
					if (abort.signal.aborted) onAbort();
				} catch (error) {
					if (outcome === "exited") outcome = "spawn_error";
					stderr = String(error).slice(0, 1024);
					finish(null, null);
				}
			});
		} finally {
			this.active.delete(abort);
			call.signal?.removeEventListener("abort", relay);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const abort of this.active) abort.abort();
	}
}

function empty(outcome: TransportOutcome): CliResult {
	return { outcome, exitCode: null, signal: null, stdout: "", stderr: "", bytes: 0, truncated: false, started: false };
}
