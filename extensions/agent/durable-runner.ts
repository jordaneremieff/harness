import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { bindInstallationPackages } from "./installation-binding.ts";

/** Read the caller installation before any host module resolves a Pi package import. */
function callerInstallation(input: unknown): string {
	const packageDir = input !== null && typeof input === "object" ? (input as { packageDir?: unknown }).packageDir : undefined;
	if (typeof packageDir !== "string" || !isAbsolute(packageDir)) throw new Error("host metadata packageDir must be an absolute path");
	return packageDir;
}

/**
 * A storage host survives its launcher; only this process holds its writer claim.
 * The runner binds Pi package imports to the caller installation for the whole
 * process, so host modules load by dynamic import after the binding.
 */
async function runDurableAgentHost(metadataJson: string): Promise<void> {
	const detachedOutput = (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") process.exitCode = 1; };
	process.stdout.on("error", detachedOutput);
	process.stderr.on("error", detachedOutput);
	const input: unknown = JSON.parse(metadataJson);
	bindInstallationPackages(callerInstallation(input), new URL("./", import.meta.url));
	const [{ parseHostMetadata }, { runHost }, { createDurableRuntime }] = await Promise.all([
		import("./host-protocol.ts"),
		import("./host-process.ts"),
		import("./durable-runtime.ts"),
	]);
	const metadata = parseHostMetadata(input);
	const host = await runHost(() => createDurableRuntime(metadata), { metadata, exit: () => process.exit(0) });
	const stop = () => { void host.close().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }); };
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try { await host.done; }
	finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const input = process.argv[2];
	if (!input) throw new Error("Durable host metadata is required");
	void runDurableAgentHost(input).catch((error: unknown) => { process.stderr.write(`Durable host failed: ${String(error)}\n`); process.exitCode = 1; });
}
