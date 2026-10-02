import { pathToFileURL } from "node:url";
import { parseHostMetadata } from "./host-protocol.ts";
import { runHost } from "./host-process.ts";
import { createDurableRuntime } from "./durable-runtime.ts";

/** A storage host survives its launcher; only this process holds its writer claim. */
export async function runDurableAgentHost(metadataJson: string): Promise<void> {
	const detachedOutput = (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") process.exitCode = 1; };
	process.stdout.on("error", detachedOutput);
	process.stderr.on("error", detachedOutput);
	const metadata = parseHostMetadata(JSON.parse(metadataJson));
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
