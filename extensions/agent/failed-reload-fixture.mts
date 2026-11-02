import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DurableHost } from "./durable-host.ts";
import { parseHostMetadata } from "./host-protocol.ts";

/** A dedicated process fails its second native open and records the closed runtime. */
const original = DurableHost.open;
let opens = 0;
DurableHost.open = async function (this: typeof DurableHost, ...args: Parameters<typeof original>) {
	if (++opens === 2) throw new Error("forced reload open failure");
	return original.apply(this, args);
};
const { createDurableRuntime } = await import("./durable-runtime.ts");
const { runHost } = await import("./host-process.ts");
const metadata = parseHostMetadata(JSON.parse(process.argv[2] ?? "null"));
function isReloadCommand(args: readonly unknown[]): boolean {
	return args[0] === "command" && args[1] !== null && typeof args[1] === "object" && "name" in args[1] && args[1].name === "reload";
}
const host = await runHost(async () => {
	const runtime = await createDurableRuntime(metadata);
	const request = runtime.request;
	runtime.request = async (...args: Parameters<typeof request>) => {
		try { return await request(...args); }
		catch (error) {
			if (isReloadCommand(args)) {
				let nextError: string | undefined;
				try { await request("status", {}, "after-failure"); }
				catch (next) { nextError = next instanceof Error ? next.message : String(next); }
				writeFileSync(join(metadata.agentDir, "reload-state.json"), JSON.stringify({ shutdownRequired: runtime.shutdownRequired ?? false, idle: runtime.isIdle(), nextError }));
			}
			throw error;
		}
	};
	return runtime;
}, { metadata, exit: () => process.exit(0) });
await host.done;
