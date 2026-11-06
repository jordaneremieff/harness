// Runs a real tab-label projector in a separate process. The projector claims a label,
// the label write reports that it never started, and the withdrawal's record read pauses
// while the record lock is held. The parent process releases the read through stdin.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabLabelProjector } from "./tab-label.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const WINDOW_ID = "window:00000000c5f1edd9";
const DEFAULT_LABEL = "Window c5f1edd9";
const SETTINGS = { executable: "rex", maxOutputBytes: 32768, maxWaitMs: 1000 };

const [agentDir, name] = process.argv.slice(2);
if (!agentDir || !name) {
	process.stderr.write("usage: tab-label-process-fixture <agentDir> <name>\n");
	process.exit(2);
}

let releaseRead: () => void = () => {};
const release = new Promise<void>((resolve) => { releaseRead = resolve; });
let paused: () => void = () => {};
const reached = new Promise<void>((resolve) => { paused = resolve; });

const mutable = fs.promises as unknown as { open: typeof import("node:fs/promises").open };
const originalOpen = mutable.open;
let armed = false;
mutable.open = async (...args) => {
	const handle = await originalOpen(...args);
	if (!armed || !String(args[0]).endsWith(".json")) return handle;
	armed = false;
	const close = handle.close.bind(handle);
	handle.close = async () => {
		paused();
		process.stdout.write("paused\n");
		await release;
		await close();
	};
	return handle;
};
syncBuiltinESMExports();

function response(value: unknown): CliResult {
	return { outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true };
}

class FixtureTransport implements RexTransport {
	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		const method = args.includes("whoami") ? "whoami" : args.at(-2) ?? "";
		if (call.signal?.aborted) return { ...response({}), outcome: "cancelled", exitCode: null };
		if (method === "whoami") return response({ host_id: "host", instance_id: "instance" });
		if (method === "com.superlogical.terminal.process") return response({ foreground: { pid: 4242 }, last_exit: null });
		if (method === "session.view") {
			return response({
				revision: 1,
				session_id: process.env.REX_SESSION,
				windows: [{ window_id: WINDOW_ID, label: DEFAULT_LABEL, layers: [{ blocks: [{ block_id: process.env.REX_BLOCK }] }] }],
			});
		}
		if (method === "session.set_window_label") {
			// The next record read is the withdrawal's decision read.
			armed = true;
			return { ...response({}), outcome: "spawn_error", exitCode: null, stdout: "", stderr: "setter did not start", started: false };
		}
		throw new Error(`Unexpected Rex method: ${method}`);
	}

	dispose(): void {}
}

const projector = createTabLabelProjector({
	agentDir,
	settings: SETTINGS,
	env: process.env,
	pid: 4242,
	getSessionName: () => name,
	createTransport: () => new FixtureTransport(),
});
const ctx = { mode: "tui", cwd: "/work/fixture", ui: { notify: () => {} } } as unknown as ExtensionContext;

projector.start(ctx);
await reached;
await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
releaseRead();
await projector.idle();
await projector.shutdown();
process.stdin.destroy();
process.stdout.write("done\n", () => process.exit(0));
