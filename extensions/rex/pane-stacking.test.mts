import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function helperFixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "rex-stacking-"));
	const sockets = new Set<Socket>();
	let events!: Socket;
	let connected!: () => void;
	const ready = new Promise<void>((resolve) => { connected = resolve; });
	const calls: string[][] = [];
	const state = { view: view(), hold: false, pending: [] as Socket[] };
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.once("data", (data) => {
			const message = JSON.parse(data.toString());
			if (message.kind === "events") { events = socket; connected(); }
			else {
				calls.push(message.args);
				if (state.hold) state.pending.push(socket);
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
socket.on('end', () => process.exit(0));
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
		state, calls, output, events, lines, child, closed, server,
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

test("helper exits when the event source ends", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	f.events.end();
	assert.deepEqual(await f.closed, [0, null]);
	assert.equal(f.stderr(), "");
});

test("helper bounds incomplete event lines and cancels an active view on stdin EOF", { timeout: 10000 }, async (t) => {
	const f = await helperFixture(t);
	f.events.write("x".repeat(65537));
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
