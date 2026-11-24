/** A single stop under the same writer lease as the serving process. No endpoint or recovery driver is started. */
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writerLeasePaths, type HostMetadata } from "./host-protocol.ts";
import { tryNativeWriterLeases } from "./native-lease.ts";
import type { stopBeforeResume } from "./durable-host.ts";

export type ColdStopResult = Awaited<ReturnType<typeof stopBeforeResume>>;
type Reply = { busy: true } | { result: ColdStopResult };

/** Only the winner opens storage. A busy lease requests attachment to its actual writer, never another launch. */
export async function withColdWriter(metadata: HostMetadata, stop: () => Promise<ColdStopResult>): Promise<Reply> {
	// The caller that reads these diagnostics can exit first. A closed pipe must not end the stop or hold its lease.
	for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
	const leases = writerLeasePaths(metadata);
	for (const path of leases) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const writer = tryNativeWriterLeases(leases);
	if (writer.kind === "busy") return { busy: true };
	// Bound this one-shot writer, including configured setup and teardown. An incomplete stop has no success reply.
	const lifetime = setTimeout(() => {
		process.stderr.write("Cold stop writer exceeded its two-minute lifetime.\n");
		process.exit(1);
	}, 120_000);
	lifetime.unref();
	// If construction or close fails, process death releases the lease after the partial runtime is gone.
	const result = await stop();
	writer.lease.release();
	clearTimeout(lifetime);
	return { result };
}

/** The isolated writer outlives its caller's wait. Its exit confirms that its lease is no longer held. */
export function stopColdStorage(metadata: HostMetadata, sessionId: string, background: boolean): Promise<Reply> {
	const runner = fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = fork(runner, [JSON.stringify(metadata), "stop", sessionId, String(background)], {
		cwd: metadata.cwd,
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	return new Promise((resolve, reject) => {
		let reply: Reply | undefined;
		let diagnostic = "";
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			diagnostic = (diagnostic + chunk).slice(-2048);
		});
		child.on("message", (message: Reply) => {
			reply = message;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0 && reply && ("busy" in reply ? reply.busy === true : reply.result?.background === background))
				resolve(reply);
			else
				reject(
					new Error(
						`Cold stop outcome unconfirmed (exit ${code ?? signal}): ${diagnostic.trim() || "no confirmed stop result"}. The stop can have marked part of the scope. Do not repeat the abort or release: a repeat can stop the target twice. Check the target with agent_status.`,
					),
				);
		});
	});
}
