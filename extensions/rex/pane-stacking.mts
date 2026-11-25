import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type PaneStackingReport, paneStacking } from "./pane-stacking.ts";
import { CliTransport } from "./transport.ts";

const MAX_EVENT_BYTES = 65536;
const MAX_VIEW_BYTES = 1048576;

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function snapshot(
	transport: CliTransport,
	prefix: string[],
	session: string,
	signal: AbortSignal,
): Promise<Record<string, unknown> & { revision: number }> {
	const result = await transport.run(
		[...prefix, "api", "call", "session.view", JSON.stringify({ session_id: session })],
		{
			timeoutMs: 5000,
			maxOutputBytes: MAX_VIEW_BYTES,
			signal,
		},
	);
	if (result.outcome !== "exited" || result.exitCode !== 0) throw new Error("View unavailable");
	const view = object(JSON.parse(result.stdout));
	if (typeof view.revision !== "number" || !Number.isSafeInteger(view.revision))
		throw new Error("Invalid view revision");
	return { ...view, revision: view.revision };
}

/**
 * The session that holds the block now, or undefined when no open block has its ID. A block keeps its ID when its tab
 * moves to another session, so the block, not a launch session, names the session to watch. A lookup without a caller
 * context searches every session.
 */
async function locate(
	transport: CliTransport,
	prefix: string[],
	block: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const result = await transport.run(
		[...prefix, "api", "call", "target.resolve", JSON.stringify({ kinds: ["block"], queries: [block] })],
		{ timeoutMs: 5000, maxOutputBytes: MAX_EVENT_BYTES, signal },
	);
	if (result.outcome !== "exited" || result.exitCode !== 0) throw new Error("Lookup unavailable");
	const results = object(JSON.parse(result.stdout)).results;
	const entry = object(Array.isArray(results) ? results[0] : undefined);
	const session = object(entry.target).session_id;
	if (entry.status === "resolved" && typeof session === "string" && session) return session;
	if (entry.status === "not_found") return undefined;
	throw new Error("Invalid lookup");
}

/** Splits the event stream into lines. A line over the limit is dropped up to its end. */
function eventLines(onLine: (line: Buffer) => void, onSkipped: () => void): (chunk: Buffer) => void {
	let pending = Buffer.alloc(0);
	let skipping = false;
	const segment = (bytes: Buffer, complete: boolean) => {
		if (!skipping && pending.length + bytes.length > MAX_EVENT_BYTES) {
			skipping = true;
			pending = Buffer.alloc(0);
			onSkipped();
		}
		if (!skipping) pending = Buffer.concat([pending, bytes]);
		if (!complete) return;
		if (!skipping) onLine(pending);
		skipping = false;
		pending = Buffer.alloc(0);
	};
	return (chunk) => {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			segment(chunk.subarray(offset, newline < 0 ? chunk.length : newline), newline >= 0);
			offset = newline < 0 ? chunk.length : newline + 1;
		}
	};
}

function writeReport(report: string, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => {
			signal.removeEventListener("abort", done);
			resolve();
		};
		signal.addEventListener("abort", done, { once: true });
		process.stdout.write(`${report}\n`, done);
	});
}

/**
 * One consumer owns one event stream, one serial snapshot call and no retained state. The stream follows the session
 * that holds the pane's block: each connection looks the session up, and a view that no longer holds the block moves
 * the stream to the block's new session.
 */
export async function runPaneStacking(): Promise<void> {
	const block = process.env.REX_BLOCK;
	if (!block) return;
	const executable = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex";
	const prefix = [
		"--autostart=false",
		"--color=never",
		...(process.env.REX_SERVER ? ["--server", process.env.REX_SERVER] : []),
	];
	const transport = new CliTransport(executable);
	let events: ReturnType<typeof spawn> | undefined;
	let reconnect: ReturnType<typeof setTimeout> | undefined;
	let reconnectDelay = 0;
	let epoch = 0;
	/** The session whose events the stream carries. */
	let session: string | undefined;
	/** The block moved to another session: the next connection starts without waiting. */
	let moved = false;
	const killEvents = () => {
		if (!events?.pid) return;
		try {
			process.kill(-events.pid, "SIGKILL");
		} catch {
			events.kill("SIGKILL");
		}
		events.stdout?.destroy();
	};
	let stopped = false;
	let finish!: () => void;
	const ended = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const abort = new AbortController();
	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (retry) clearTimeout(retry);
		if (reconnect) clearTimeout(reconnect);
		abort.abort();
		transport.dispose();
		killEvents();
		finish();
	};
	let revision = -1;
	let requested = -1;
	let dirty = true;
	let active: Promise<void> | undefined;
	let lastReport: string | undefined;
	let retryDelay = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const publish = async (value: PaneStackingReport) => {
		const report = JSON.stringify(value);
		if (report !== lastReport) {
			lastReport = report;
			await writeReport(report, abort.signal);
		}
	};
	const publishView = async (view: { revision: number }, report: PaneStackingReport) => {
		retryDelay = 0;
		// A restarted server's lower view supersedes pending revisions from the old server.
		if (view.revision < revision) requested = -1;
		revision = view.revision;
		if (requested <= revision) dirty = false;
		await publish(report);
	};
	/** Ends the stream of the old session; its exit connects to the session that holds the block now. */
	const follow = (next: string) => {
		session = next;
		moved = true;
		killEvents();
	};
	/** The session that holds the block after a view: a view without the block can mean that its tab moved. */
	const holderAfter = async (watched: string, report: PaneStackingReport) =>
		report.pane === null ? locate(transport, prefix, block, abort.signal) : watched;
	const refresh = async () => {
		while (dirty && !stopped && session) {
			dirty = false;
			const startedEpoch = epoch;
			const watched = session;
			const view = await snapshot(transport, prefix, watched, abort.signal);
			const report = paneStacking(view, block);
			const holder = await holderAfter(watched, report);
			if (stopped) return;
			if (startedEpoch !== epoch) {
				dirty = true;
				continue;
			}
			if (holder !== undefined && holder !== watched) return follow(holder);
			await publishView(view, report);
		}
	};
	// Failed view calls retry after one, two, four, then five seconds until input ends.
	const retryLater = () => {
		if (stopped || retry) return;
		dirty = true;
		retryDelay = retryDelay === 0 ? 1000 : Math.min(retryDelay * 2, 5000);
		retry = setTimeout(() => {
			retry = undefined;
			startRefresh();
		}, retryDelay);
	};
	const startRefresh = () => {
		if (active || stopped || retry) return;
		active = refresh()
			.catch(retryLater)
			.finally(() => {
				active = undefined;
				if (dirty && !stopped && !retry) startRefresh();
			});
	};
	const line = (bytes: Buffer) => {
		let value: Record<string, unknown>;
		try {
			value = object(JSON.parse(bytes.toString("utf8")));
		} catch {
			return;
		}
		const event = object(object(value.payload).event);
		if (event.type !== "session_view_changed") return;
		const next = object(event.payload).revision;
		if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= revision || next <= requested) return;
		requested = next;
		dirty = true;
		startRefresh();
	};
	// Failed connections retry after one, two, four, then five seconds; a connection that lasted five seconds resets it.
	const later = (lasted = 0) => {
		if (stopped) return;
		if (lasted >= 5000) reconnectDelay = 0;
		reconnectDelay = reconnectDelay === 0 ? 1000 : Math.min(reconnectDelay * 2, 5000);
		reconnect = setTimeout(() => {
			reconnect = undefined;
			void connect();
		}, reconnectDelay);
	};
	const connect = async () => {
		if (stopped) return;
		let holder: string | undefined;
		try {
			holder = await locate(transport, prefix, block, abort.signal);
		} catch {
			return later();
		}
		if (stopped) return;
		if (holder === undefined) {
			// No open block has this ID, so the pane is in no window.
			await publish({ version: 1, pane: null });
			return later();
		}
		session = holder;
		listen(holder);
	};
	const listen = (watched: string) => {
		moved = false;
		const child = spawn(executable, [...prefix, "events", "-s", watched, "--json"], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		events = child;
		const started = performance.now();
		let ended = false;
		const disconnected = () => {
			if (ended || stopped) return;
			ended = true;
			killEvents();
			if (moved) {
				moved = false;
				reconnectDelay = 0;
				return void connect();
			}
			later(performance.now() - started);
		};
		child.once("spawn", () => {
			if (stopped) {
				killEvents();
				return;
			}
			epoch++;
			revision = requested = -1;
			dirty = true;
			startRefresh();
		});
		// Each connection owns its line buffer; an incomplete old line never joins a new stream.
		const split = eventLines(line, () => {
			dirty = true;
			startRefresh();
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (!stopped && !ended) split(chunk);
		});
		child.once("error", disconnected);
		child.once("exit", disconnected);
	};
	process.stdin.once("end", stop);
	process.stdin.once("error", stop);
	process.stdout.once("error", stop);
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.once("SIGHUP", stop);
	process.once("exit", stop);
	process.stdin.resume();
	if (process.stdin.readableEnded || process.stdin.destroyed) stop();
	void connect();
	await ended;
	await active;
	process.stdin.pause();
	process.stdin.removeListener("end", stop);
	process.stdin.removeListener("error", stop);
	process.stdout.removeListener("error", stop);
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
	process.removeListener("SIGHUP", stop);
	process.removeListener("exit", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runPaneStacking();
}
