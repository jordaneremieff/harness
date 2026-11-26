import assert from "node:assert/strict";
import test from "node:test";
import { preparePane } from "./pane-launch.ts";
import { servePane } from "./pane-service.ts";

const origin = { version: 1, terminal: "Rex", exact: { blockId: "invoking-pane" } };
const executable = "/installed/Editor.app/Contents/MacOS/Editor";

test("an exact opening origin precedes installation and one fixed native split", async () => {
	const steps: string[] = [];
	const signal = new AbortController().signal;
	const receipt = { anchorId: "invoking-pane", blockId: "editor-pane" };
	const launch = await preparePane(
		"/agent",
		signal,
		async (program, verb, childSignal, input) => {
			steps.push(verb);
			assert.equal(childSignal, signal);
			if (verb === "capture") {
				assert.ok(program.endsWith("/terminal-origin.ts"));
				assert.equal(input, undefined);
				return origin;
			}
			assert.ok(program.endsWith("/terminal-pane.ts"));
			assert.deepEqual(input, {
				version: 1,
				origin,
				argv: [executable, "--pane", "/private/grant"],
				cwd: "/folder",
				placement: { side: "right", share: 0.55 },
				label: "Editor",
			});
			return { version: 1, outcome: "created", receipt };
		},
		async (dir) => {
			assert.equal(dir, "/agent");
			steps.push("install");
			return executable;
		},
	);
	assert.equal(await launch("/folder", "/private/grant"), receipt);
	assert.deepEqual(steps, ["capture", "install", "split"]);
});

test("a missing origin does not build, an aborted install does not dispatch, and an uncertain split never retries", async () => {
	const stop = new AbortController();
	for (const absent of [null, { version: 1, terminal: "Rex" }]) {
		await assert.rejects(
			preparePane(
				"/agent",
				stop.signal,
				async () => absent,
				async () => assert.fail("No installation permitted"),
			),
			/exact pane/,
		);
	}
	let splits = 0;
	const launch = await preparePane(
		"/agent",
		stop.signal,
		async (_path, verb) => {
			if (verb === "capture") return origin;
			splits++;
			return { version: 1, outcome: "uncertain" };
		},
		async () => executable,
	);
	await assert.rejects(launch("/folder", "/ticket"), /did not confirm/);
	await assert.rejects(
		preparePane(
			"/agent",
			stop.signal,
			async () => origin,
			async () => {
				stop.abort();
				return executable;
			},
		),
		{ name: "AbortError" },
	);
	await assert.rejects(launch("/folder", "/ticket"), { name: "AbortError" });
	assert.equal(splits, 1);
});

test("only a native client with the pane grant can acknowledge the view or use the workspace", async (t) => {
	const pane = await servePane(async (body) => ({ operation: body.op }));
	t.after(pane.close);
	const endpoint = `http://127.0.0.1:${pane.port}/api`;
	const call = (op: string, headers: Record<string, string> = {}) =>
		fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${pane.token}`, ...headers },
			body: JSON.stringify({ op }),
		});
	assert.equal((await fetch(endpoint)).status, 404);
	assert.equal((await fetch(new URL("/", endpoint))).status, 404);
	assert.equal((await call("ready", { Authorization: "" })).status, 403);
	assert.equal((await call("ready", { Origin: new URL(endpoint).origin })).status, 403);
	assert.equal((await call("ready", { Origin: "null" })).status, 403);
	assert.deepEqual(await (await call("state")).json(), { operation: "state" });
	assert.equal((await call("loaded")).status, 200);
	assert.equal(await pane.waitForLoad(100), true);
	assert.equal(await pane.waitForView(5), false);
	const visible = pane.waitForView(2000);
	assert.deepEqual(await (await call("ready")).json(), { ready: true });
	assert.equal(await visible, true);
	assert.equal((await call("closed")).status, 200);
	await pane.ended;
	await assert.rejects(call("state"));
});

test("a stopped or unacknowledged pane never counts as visible", async () => {
	const pane = await servePane(async () => ({}));
	assert.equal(await pane.waitForView(5), false);
	await pane.close();
	const unopened = await servePane(async () => ({}));
	const pending = unopened.waitForView(2000);
	await unopened.close();
	assert.equal(await pending, false);
});
