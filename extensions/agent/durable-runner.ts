import { EventEmitter } from "node:events";
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

/** Read the caller installation before any host module resolves a Pi package import. */
function callerInstallation(input: unknown): string {
	const packageDir =
		input !== null && typeof input === "object" ? (input as { packageDir?: unknown }).packageDir : undefined;
	if (typeof packageDir !== "string" || !isAbsolute(packageDir))
		throw new Error("host metadata packageDir must be an absolute path");
	return packageDir;
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
	const [{ parseHostMetadata }, { runHost, HostClaimRefusedError }, { createDurableRuntime, stopColdRuntime }] =
		await Promise.all([import("./host-protocol.ts"), import("./host-process.ts"), import("./durable-runtime.ts")]);
	const metadata = parseHostMetadata(input);
	if (process.argv[3] === "stop") {
		const sessionId = process.argv[4];
		const background = process.argv[5];
		if (!sessionId || (background !== "true" && background !== "false"))
			throw new Error("Cold stop requires its exact target and background scope");
		const { withColdWriter } = await import("./cold-stop.ts");
		const reply = await withColdWriter(metadata, () => stopColdRuntime(metadata, sessionId, background === "true"));
		// Finish even when the invoking process has gone. No scheduler or delivery stays in this process.
		if (process.connected && process.send) process.send(reply, () => process.exit(0));
		else process.exit(0);
		return;
	}
	const host = await runHost(() => createDurableRuntime(metadata), { metadata, exit: () => process.exit(0) }).catch(
		(error: unknown) => {
			if (!(error instanceof HostClaimRefusedError) || error.observation !== "busy") throw error;
			return undefined;
		},
	);
	if (!host) return;
	const stop = () => {
		void host.close().catch((error: unknown) => {
			process.stderr.write(`${String(error)}\n`);
			process.exitCode = 1;
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
	void runDurableAgentHost(input).catch((error: unknown) => {
		// Process exit stops a partial runtime before the kernel releases its lease.
		process.stderr.write(`Durable host failed: ${String(error)}\n`, () => process.exit(1));
	});
}
