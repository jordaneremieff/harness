/** Deliver the named recipients' rows under a cold writer lease, without a scheduler. */
import { fork } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GATE_PASSED, isPhase, PROCEED, COLD_STOP_GATE_WAIT_MS } from "./cold-stop.ts";
import { HostError, type HostMetadata } from "./host-protocol.ts";

/** What a cold delivery did for its recipients. */
export interface ColdDeliveryResult {
	/** The storage holds a task that a host stopped while it ran; only an execution host may open it. */
	readonly interrupted?: true;
	/** The scheduler state when the writer closed: a cold delivery never starts it. */
	readonly scheduling: "paused" | "running" | "closing";
	/** Recipient storages of this delivery that still hold pending rows: parked, refused or held for retry. */
	readonly remaining: readonly string[];
}

type Reply<T> = { readonly busy: true } | { readonly result: T };

export interface ColdWriterOptions {
	readonly signal?: AbortSignal;
	readonly gateWaitMs?: number;
	/** Runner entry path. Defaults to the sibling `durable-runner.ts`. */
	readonly runner?: string;
	/** Extra runner environment; merged over the current environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

function writerError(mode: string, code: number | null, signal: NodeJS.Signals | null, diagnostic: string): Error {
	return new HostError(
		`The ${mode} writer ended without a confirmed result (exit ${code ?? signal}): ${diagnostic.trim() || "no result"}`,
		"unavailable",
	);
}

/**
 * Run one cold writer mode in a runner process. Until the writer passes the start gate it has changed nothing, so
 * the caller's signal or the gate bound ends it without effect; after that the writer finishes on its own.
 */
function runColdWriter<T>(
	metadata: HostMetadata,
	mode: "deliver",
	args: readonly string[],
	options: ColdWriterOptions = {},
): Promise<Reply<T>> {
	options.signal?.throwIfAborted();
	if (!statSync(metadata.cwd, { throwIfNoEntry: false })?.isDirectory())
		return Promise.reject(new HostError(`The agent's working directory no longer exists: ${metadata.cwd}`, "invalid"));
	const runner = options.runner ?? fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = fork(runner, [JSON.stringify(metadata), mode, ...args], {
		cwd: metadata.cwd,
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
	});
	return new Promise((resolveReply, reject) => {
		let reply: unknown;
		let diagnostic = "";
		let gatePassed = false;
		let withdrawn: Error | undefined;
		const withdraw = (reason: Error) => {
			if (gatePassed || withdrawn) return;
			withdrawn = reason;
			child.kill("SIGKILL");
		};
		const gateTimer = setTimeout(
			() =>
				withdraw(new HostError(`A host of this storage is still starting; the ${mode} writer left.`, "unavailable")),
			options.gateWaitMs ?? COLD_STOP_GATE_WAIT_MS,
		);
		const aborted = () => withdraw(new Error(`The ${mode} writer was withdrawn before it opened the storage.`));
		options.signal?.addEventListener("abort", aborted, { once: true });
		const passGate = () => {
			gatePassed = true;
			clearTimeout(gateTimer);
			options.signal?.removeEventListener("abort", aborted);
		};
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			diagnostic = (diagnostic + chunk).slice(-2048);
		});
		child.on("message", (message: unknown) => {
			if (isPhase(message, GATE_PASSED.phase)) {
				if (withdrawn) return;
				passGate();
				if (child.connected) child.send(PROCEED, () => undefined);
			} else reply = message;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			passGate();
			if (withdrawn) return reject(withdrawn);
			const value = reply as { busy?: unknown; result?: unknown; unconfirmed?: unknown } | undefined;
			if (code === 0 && value?.busy === true) return resolveReply({ busy: true });
			if (code === 0 && value !== undefined && "result" in value) return resolveReply({ result: value.result as T });
			reject(writerError(mode, code, signal, diagnostic));
		});
	});
}

/** Deliver the rows of one storage to the named recipient storages, without its scheduler. */
export function deliverColdStorage(
	metadata: HostMetadata,
	recipients: readonly string[],
	options: ColdWriterOptions = {},
): Promise<Reply<ColdDeliveryResult>> {
	return runColdWriter(metadata, "deliver", [JSON.stringify(recipients)], options);
}
