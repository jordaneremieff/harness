import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { paneStacking } from "./pane-stacking.ts";
import { CliTransport } from "./transport.ts";

const MAX_EVENT_BYTES = 65536;
const MAX_VIEW_BYTES = 1048576;

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function snapshot(transport: CliTransport, prefix: string[], session: string, signal: AbortSignal): Promise<Record<string, unknown> & { revision: number }> {
	const result = await transport.run([...prefix, "api", "call", "session.view", JSON.stringify({ session_id: session })], {
		timeoutMs: 5000, maxOutputBytes: MAX_VIEW_BYTES, signal,
	});
	if (result.outcome !== "exited" || result.exitCode !== 0) throw new Error("View unavailable");
	const view = object(JSON.parse(result.stdout));
	if (typeof view.revision !== "number" || !Number.isSafeInteger(view.revision)) throw new Error("Invalid view revision");
	return { ...view, revision: view.revision };
}

function writeReport(report: string, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => { signal.removeEventListener("abort", done); resolve(); };
		signal.addEventListener("abort", done, { once: true });
		process.stdout.write(`${report}\n`, done);
	});
}

/** One consumer owns one event stream, one serial snapshot call and no retained state. */
export async function runPaneStacking(): Promise<void> {
	const session = process.env.REX_SESSION;
	const block = process.env.REX_BLOCK;
	if (!session || !block) return;
	const executable = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex";
	const prefix = ["--autostart=false", "--color=never", ...(process.env.REX_SERVER ? ["--server", process.env.REX_SERVER] : [])];
	const transport = new CliTransport(executable);
	const events = spawn(executable, [...prefix, "events", "-s", session, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
	let stopped = false;
	let finish!: () => void;
	const ended = new Promise<void>((resolve) => { finish = resolve; });
	const abort = new AbortController();
	const stop = () => {
		if (stopped) return;
		stopped = true;
		abort.abort();
		transport.dispose();
		events.kill("SIGKILL");
		finish();
	};
	let revision = -1;
	let requested = -1;
	let dirty = true;
	let active: Promise<void> | undefined;
	let lastReport: string | undefined;
	const refresh = async () => {
		while (dirty && !stopped) {
			dirty = false;
			const view = await snapshot(transport, prefix, session, abort.signal);
			if (stopped) return;
			if (view.revision < revision) { stop(); return; }
			revision = view.revision;
			if (requested <= revision) dirty = false;
			const report = JSON.stringify(paneStacking(view, block));
			if (report !== lastReport) {
				lastReport = report;
				await writeReport(report, abort.signal);
			}
		}
	};
	const startRefresh = () => {
		if (active || stopped) return;
		active = refresh().catch(stop).finally(() => { active = undefined; if (dirty && !stopped) startRefresh(); });
	};
	const line = (bytes: Buffer) => {
		let value: Record<string, unknown>;
		try { value = object(JSON.parse(bytes.toString("utf8"))); } catch { return; }
		const event = object(object(value.payload).event);
		if (event.type !== "session_view_changed") return;
		const next = object(event.payload).revision;
		if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= revision || next <= requested) return;
		requested = next;
		dirty = true;
		startRefresh();
	};
	let pending = Buffer.alloc(0);
	events.stdout.on("data", (chunk: Buffer) => {
		if (stopped) return;
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			if (pending.length + end - offset > MAX_EVENT_BYTES) { stop(); return; }
			pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
			if (newline < 0) return;
			line(pending);
			pending = Buffer.alloc(0);
			offset = newline + 1;
		}
	});
	events.once("error", stop);
	events.once("exit", stop);
	process.stdin.once("end", stop);
	process.stdin.once("error", stop);
	process.stdout.once("error", stop);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.once("exit", stop);
	process.stdin.resume();
	if (process.stdin.readableEnded || process.stdin.destroyed) stop();
	startRefresh();
	await ended;
	await active;
	process.stdin.pause();
	process.stdin.removeListener("end", stop);
	process.stdin.removeListener("error", stop);
	process.stdout.removeListener("error", stop);
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
	process.removeListener("exit", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runPaneStacking();
}
