import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { paneStacking } from "./pane-stacking.ts";

const full = [0, 0, 1, 1];
const half = [0, 0, 0.5, 1];
const overlap = [0.2, 0.2, 0.4, 0.4];
function layer(id: string, bounds = full, kind = "floating") {
	return { kind, bounds, layout: { block_id: id, rect: bounds } };
}
function view(layers = [layer("pane", half, "tiled"), layer("float", overlap)], zoomed_block_id?: string) {
	return { revision: 1, windows: [{ layers, zoomed_block_id }] };
}

test("tiled pane reports an intersecting front layer", () => {
	assert.deepEqual(paneStacking(view(), "pane"), { version: 1, pane: half, above: [overlap] });
});
test("floating pane reports later layers but not earlier layers", () => {
	const layout = view([layer("base", full, "tiled"), layer("earlier", overlap), layer("pane", overlap), layer("later", overlap)]);
	assert.deepEqual(paneStacking(layout, "pane"), { version: 1, pane: overlap, above: [overlap] });
	assert.deepEqual(paneStacking(layout, "later"), { version: 1, pane: overlap, above: [] });
});
test("non-intersecting layers and edge contact do not cover a pane", () => {
	assert.deepEqual(paneStacking(view([layer("pane", half, "tiled"), layer("right", [0.5, 0, 0.5, 1])]), "pane"), { version: 1, pane: half, above: [] });
});
test("a different zoomed tiled block covers the whole pane", () => {
	const layout = { windows: [{ zoomed_block_id: "other", layers: [
		{ kind: "tiled", bounds: full, layout: { rect: full, split: { before: { block_id: "pane", rect: half }, after: { block_id: "other", rect: [0.5, 0, 0.5, 1] } } } },
		layer("float", overlap),
	] }] };
	assert.deepEqual(paneStacking(layout, "pane"), { version: 1, pane: half, above: [full] });
	assert.deepEqual(paneStacking(layout, "float"), { version: 1, pane: overlap, above: [] });
});
test("a zoomed pane fills the window and retains floating layers above it", () => {
	assert.deepEqual(paneStacking(view(undefined, "pane"), "pane"), { version: 1, pane: full, above: [overlap] });
});
test("absent blocks have no pane", () => {
	assert.deepEqual(paneStacking(view(), "absent"), { version: 1, pane: null });
	assert.deepEqual(paneStacking(null, "pane"), { version: 1, pane: null });
});
test("rectangles clamp to fractions, unknown layers act as floating, and coverage stops at 64", () => {
	const layout = view([layer("pane", [-1, -1, 2, 2], "tiled"), ...Array.from({ length: 70 }, (_, i) => layer(`front${i}`, overlap, "unknown"))]);
	const report = paneStacking(layout, "pane");
	assert.notEqual(report.pane, null);
	if (report.pane) {
		assert.deepEqual(report.pane, full);
		assert.equal(report.above.length, 64);
	}
});

async function helperFixture(t: test.TestContext, options: { failures?: number; eventExitCode?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "rex-stacking-"));
	const sockets = new Set<Socket>();
	let events!: Socket;
	let connected!: () => void;
	const ready = new Promise<void>((resolve) => { connected = resolve; });
	const calls: string[][] = [];
	const state = { view: view(), hold: false, pending: [] as Socket[], failures: options.failures ?? 0 };
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.once("data", (data) => {
			const message = JSON.parse(data.toString());
			if (message.kind === "events") { events = socket; connected(); server.emit("events", socket); }
			else {
				calls.push(message.args);
				if (state.hold) state.pending.push(socket);
				else if (state.failures > 0) { state.failures -= 1; socket.end("not a view"); }
				else socket.end(JSON.stringify(state.view));
				server.emit("view");
			}
		});
	});
	const socketPath = join(root, "control.sock");
	server.listen(socketPath);
	await once(server, "listening");
	await writeFile(join(root, "rex"), `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
const streaming = args.includes('events');
const socket = net.connect(process.env.STACKING_SOCKET, () => socket.write(JSON.stringify({kind: streaming ? 'events' : 'view', args})));
socket.on('data', data => process.stdout.write(data));
socket.on('end', () => process.exit(streaming ? ${options.eventExitCode ?? 0} : 0));
`, { mode: 0o755 });
	const child = spawn(process.execPath, [fileURLToPath(new URL("./pane-stacking.mts", import.meta.url))], {
		env: { ...process.env, REX_SESSION: "session:test", REX_BLOCK: "pane", REX_SERVER: "unix:///test", REX_BIN_DIR: root, STACKING_SOCKET: socketPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout });
	const output: string[] = [];
	lines.on("line", (line) => output.push(line));
	t.after(async () => {
		child.kill("SIGKILL");
		for (const socket of sockets) socket.destroy();
		server.close();
		await closed;
		await rm(root, { recursive: true, force: true });
	});
	await ready;
	if (!output.length) await once(lines, "line");
	return {
		root, state, calls, output, get events() { return events; }, lines, child, closed, server,
		stderr: () => stderr,
		event(revision: number) { events.write(`${JSON.stringify({ payload: { event: { type: "session_view_changed", payload: { revision } } } })}\n`); },
	};
}

test("helper emits only changed reports, ignores old revisions and exits on stdin EOF", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	assert.deepEqual(JSON.parse(f.output[0] ?? ""), paneStacking(f.state.view, "pane"));
	assert.deepEqual(f.calls[0], ["--autostart=false", "--color=never", "--server", "unix:///test", "api", "call", "session.view", '{"session_id":"session:test"}']);
	f.state.view.revision = 2;
	const unchanged = once(f.server, "view");
	f.event(2);
	await unchanged;
	f.state.view = { ...view([layer("pane", full, "tiled")]), revision: 4 };
	const changed = once(f.lines, "line");
	f.event(1);
	f.event(2);
	f.event(4);
	await changed;
	assert.equal(f.calls.length, 3);
	assert.equal(f.output.length, 2);
	assert.deepEqual(JSON.parse(f.output[1] ?? ""), { version: 1, pane: full, above: [] });
	const disconnected = once(f.events, "close");
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	await disconnected;
	assert.equal(f.stderr(), "");
});

test("helper reconnects after event exit, refreshes a restarted revision and receives new events", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	f.state.view = { ...view([layer("pane", overlap)]), revision: 8 };
	const oldReport = once(f.lines, "line");
	f.event(8);
	await oldReport;
	f.state.view = { ...view([layer("pane", full, "tiled")]), revision: 1 };
	const connected = once(f.server, "events");
	const refreshed = once(f.lines, "line");
	f.events.write('{"incomplete":');
	f.events.end();
	await connected;
	await refreshed;
	assert.deepEqual(JSON.parse(f.output.at(-1) ?? ""), { version: 1, pane: full, above: [] });
	f.state.view = { ...view(), revision: 2 };
	const updated = once(f.lines, "line");
	f.event(2);
	await updated;
	assert.deepEqual(JSON.parse(f.output.at(-1) ?? ""), paneStacking(f.state.view, "pane"));
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	assert.equal(f.stderr(), "");
});

test("a lower recovered view clears old pending revisions without an event reconnect", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	f.state.view = { ...view([layer("pane", overlap)]), revision: 8 };
	let changed = once(f.lines, "line");
	f.event(8);
	await changed;
	f.state.view = { ...view([layer("pane", full, "tiled")]), revision: 1 };
	changed = once(f.lines, "line");
	f.events.write(`${"x".repeat(65537)}\n`);
	await changed;
	f.state.view = { ...view(), revision: 2 };
	changed = once(f.lines, "line");
	f.event(2);
	await changed;
	assert.deepEqual(JSON.parse(f.output.at(-1) ?? ""), paneStacking(f.state.view, "pane"));
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
});

test("failed event streams reconnect with one, two, four and five second backoff", { timeout: 20000 }, async (t) => {
	const f = await helperFixture(t, { eventExitCode: 1 });
	for (const delay of [1000, 2000, 4000, 5000]) {
		const connected = once(f.server, "events");
		const started = performance.now();
		f.events.end();
		await connected;
		assert.ok(performance.now() - started >= delay - 50, `reconnect waits at least ${delay} ms`);
	}
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	assert.equal(f.stderr(), "");
});

test("helper retries an event spawn error and resumes after the executable returns", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	const executable = join(f.root, "rex");
	const disabled = join(f.root, "disabled-rex");
	await rename(executable, disabled);
	const connected = once(f.server, "events");
	const started = performance.now();
	f.events.end();
	let timer: ReturnType<typeof setTimeout>;
	const restored = new Promise<void>((resolve, reject) => {
		timer = setTimeout(() => { rename(disabled, executable).then(resolve, reject); }, 1500);
	});
	t.after(() => clearTimeout(timer));
	await Promise.all([connected, restored]);
	assert.ok(performance.now() - started >= 2950, "the absent executable uses the second reconnect interval");
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	assert.equal(f.stderr(), "");
});

test("helper exits at input EOF during event reconnect backoff", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	const disconnected = once(f.events, "close");
	f.events.end();
	await disconnected;
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	assert.equal(f.stderr(), "");
});

test("helper terminates its event child on interrupt, termination and hangup signals", { timeout: 10000 }, async (t) => {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const f = await helperFixture(t);
		const disconnected = once(f.events, "close");
		f.child.kill(signal);
		assert.deepEqual(await f.closed, [0, null]);
		await disconnected;
		assert.equal(f.stderr(), "");
	}
});

test("helper retries a failed view and keeps its feed", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t, { failures: 1 });
	assert.equal(f.calls.length, 2);
	assert.deepEqual(JSON.parse(f.output[0] ?? ""), paneStacking(f.state.view, "pane"));
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
});

test("helper skips an oversized event line and cancels an active view on stdin EOF", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	f.state.view = { ...view([layer("pane", full, "tiled")]), revision: 5 };
	const changed = once(f.lines, "line");
	f.events.write("x".repeat(65537));
	f.events.write("\n");
	f.event(5);
	await changed;
	assert.deepEqual(JSON.parse(f.output.at(-1) ?? ""), { version: 1, pane: full, above: [] });
	f.child.stdin.end();
	assert.deepEqual(await f.closed, [0, null]);
	const second = await helperFixture(t);
	second.state.hold = true;
	const requested = once(second.server, "view");
	second.event(2);
	await requested;
	const pending = second.state.pending[0];
	assert.ok(pending);
	const disconnected = once(pending, "close");
	second.child.stdin.end();
	assert.deepEqual(await second.closed, [0, null]);
	await disconnected;
});
