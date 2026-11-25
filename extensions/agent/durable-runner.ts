import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { bindInstallationPackages } from "./installation-binding.ts";

/**
 * The host loads every configured extension on one Pi event bus, an EventEmitter without its own
 * listener limit. Each extension can subscribe once to a shared request channel, so Node's default
 * of ten reports those intended subscriptions as a leak in the host's error output. This limit is
 * well above one listener per extension, so a channel that keeps growing still warns.
 */
const EXTENSION_BUS_LISTENER_LIMIT = 64;

/**
 * Once its service has ended, the process stops at the latest this long afterwards. The writer lease is released
 * or was never taken by then, so nothing that still runs has storage work to finish; MCP servers that outlive the
 * process are ended by their guardian.
 */
const SERVICE_END_EXIT_MS = 5_000;

/** Report on stderr; a closed or broken pipe never stops the exit that follows the report. */
function diagnostic(text: string): void {
	try {
		writeSync(2, text);
	} catch {
		/* The process outlives its launcher's pipes. */
	}
}

/**
 * End the process when its service has ended: after clean retirement, release or close, and after a refused
 * start. It ends as soon as nothing else runs, and at the latest after the grace, so a handle that an extension,
 * a child transport or a socket leaves open cannot keep a retired runner alive.
 */
function endAfterService(): void {
	const timer = setTimeout(() => {
		diagnostic(
			`Durable host: open handles kept the process running ${SERVICE_END_EXIT_MS / 1000} s after its service ended; it exits now.\n`,
		);
		process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
	}, SERVICE_END_EXIT_MS);
	timer.unref();
}

/** Read the caller installation before any host module resolves a Pi package import. */
function callerInstallation(input: unknown): string {
	const packageDir =
		input !== null && typeof input === "object" ? (input as { packageDir?: unknown }).packageDir : undefined;
	if (typeof packageDir !== "string" || !isAbsolute(packageDir))
		throw new Error("host metadata packageDir must be an absolute path");
	return packageDir;
}

const COLD_LABELS = { stop: "Cold stop", deliver: "Cold delivery", index: "Recipient index" } as const;

/** The work of one cold writer mode, with its arguments checked before the writer takes any lease. */
function coldWork(
	metadata: import("./host-protocol.ts").HostMetadata,
	mode: keyof typeof COLD_LABELS,
	runtime: Pick<typeof import("./durable-runtime.ts"), "stopColdRuntime" | "deliverColdRuntime" | "indexColdRuntime">,
): () => Promise<unknown> {
	if (mode === "deliver") {
		const recipients = coldRecipients(process.argv[4]);
		return () => runtime.deliverColdRuntime(metadata, recipients);
	}
	if (mode === "index") return () => runtime.indexColdRuntime(metadata);
	const sessionId = process.argv[4];
	const background = process.argv[5];
	if (!sessionId || (background !== "true" && background !== "false"))
		throw new Error("Cold stop requires its exact target and background scope");
	return () => runtime.stopColdRuntime(metadata, sessionId, background === "true");
}

/** The recipient storages of a cold delivery, as its caller named them. */
function coldRecipients(text: string | undefined): string[] {
	const value: unknown = JSON.parse(text ?? "null");
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string"))
		throw new Error("Cold delivery requires its exact recipient storages");
	return value as string[];
}

/**
 * A storage host survives its launcher; only this process holds its writer claim.
 * The runner binds Pi package imports to the caller installation for the whole
 * process, so host modules load by dynamic import after the binding.
 */
async function runDurableAgentHost(metadataJson: string): Promise<void> {
	const detachedOutput = (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") process.exitCode = 1;
	};
	process.stdout.on("error", detachedOutput);
	process.stderr.on("error", detachedOutput);
	// Pi enables Node's compile cache in its own process, and a child does not inherit it. Enabling it
	// before the dynamic imports lets each host start reuse the compiled host and Pi modules.
	enableCompileCache();
	EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, EXTENSION_BUS_LISTENER_LIMIT);
	const input: unknown = JSON.parse(metadataJson);
	bindInstallationPackages(callerInstallation(input), new URL("./", import.meta.url));
	const [
		{ parseHostMetadata },
		{ runHost, HostClaimRefusedError },
		{ createDurableRuntime, stopColdRuntime, deliverColdRuntime, indexColdRuntime },
	] = await Promise.all([import("./host-protocol.ts"), import("./host-process.ts"), import("./durable-runtime.ts")]);
	const metadata = parseHostMetadata(input);
	const mode = process.argv[3];
	if (mode === "stop" || mode === "deliver" || mode === "index") {
		const work = coldWork(metadata, mode, { stopColdRuntime, deliverColdRuntime, indexColdRuntime });
		const { withColdWriter } = await import("./cold-stop.ts");
		const reply = await withColdWriter(metadata, work, COLD_LABELS[mode]);
		// Finish even when the invoking process has gone. No scheduler or delivery stays in this process.
		if (process.connected && process.send) process.send(reply, () => process.exit(0));
		else process.exit(0);
		return;
	}
	// A bootstrap step that waits on nothing lets the event loop empty before readiness; say so instead of a silent exit 0.
	const unsettled = () => {
		process.stderr.write(
			"Durable host: bootstrap ended without readiness; a configured extension or a host step left a promise that can never settle.\n",
		);
		process.exitCode = 1;
	};
	process.once("beforeExit", unsettled);
	const host = await runHost((bootstrap) => createDurableRuntime(metadata, { decisionWait: bootstrap.decisionWait }), {
		metadata,
		exit: (status) => process.exit(status),
	})
		.catch((error: unknown) => {
			if (!(error instanceof HostClaimRefusedError) || error.observation !== "busy") throw error;
			return undefined;
		})
		.finally(() => process.off("beforeExit", unsettled));
	if (!host) return;
	// The host arms its own shutdown deadline for every shutdown path, signals included.
	const stop = () => {
		void host.close().catch((error: unknown) => {
			process.stderr.write(`${String(error)}\n`);
			process.exit(1);
		});
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await host.done;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const input = process.argv[2];
	if (!input) throw new Error("Durable host metadata is required");
	void runDurableAgentHost(input).then(
		() => endAfterService(),
		(error: unknown) => {
			// Process exit stops a partial runtime before the kernel releases its lease.
			process.stderr.write(`Durable host failed: ${String(error)}\n`, () => process.exit(1));
		},
	);
}
