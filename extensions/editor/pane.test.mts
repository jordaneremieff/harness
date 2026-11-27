import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PaneEvent } from "./pane-events.ts";
import { preparePane } from "./pane-launch.ts";
import { EditorRoom } from "./room.ts";
import { Workspace } from "./store.ts";

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

test("the pane-owned child outlives a session, attaches another and delivers live events until stdin closes", {
	timeout: 12_000,
}, async (t) => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "editor-service-")));
	const root = join(dir, "project"),
		agentDir = join(dir, "agent");
	await mkdir(root);
	await mkdir(agentDir, { mode: 0o700 });
	const doc = "draft.txt";
	await writeFile(join(root, doc), "Before\n");
	const starter = { id: "ordinary:starter", label: "Opening Pi", kind: "ordinary" } as const;
	const second = { id: "ordinary:other", label: "Another Pi", kind: "ordinary" } as const;
	const noSplit = async () => {
		throw Error("Do not create a split when an Editor is visible");
	};
	const opened = new EditorRoom(agentDir, root, starter, async () => {}, noSplit);
	const attached = new EditorRoom(agentDir, root, second, async () => {}, noSplit);
	let child: ReturnType<typeof spawn> | undefined;
	t.after(async () => {
		if (child?.exitCode === null) child.kill();
		await Promise.all([opened.close(), attached.close()]);
		await rm(dir, { recursive: true, force: true });
	});
	await opened.tool({ op: "join" });
	const proc = spawn(process.execPath, [fileURLToPath(new URL("./pane-program.ts", import.meta.url))], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: root,
		env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir },
	});
	child = proc;
	const exit = once(proc, "exit");
	const stdout = createInterface({ input: proc.stdout });
	const line = once(stdout, "line", { signal: AbortSignal.timeout(4000) });
	proc.stdin.write(
		`${JSON.stringify({ root, agentDir, paneId: randomUUID(), participant: starter, appPid: process.pid })}\n`,
	);
	const { port, token } = JSON.parse((await line)[0]);
	const endpoint = `http://127.0.0.1:${port}/api`;
	const request = (
		op: string,
		fields: Record<string, unknown> = {},
		headers: Record<string, string> = {},
		signal = AbortSignal.timeout(4000),
	) =>
		fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
			body: JSON.stringify({ op, ...fields }),
			signal,
		});
	async function call(op: string, fields?: Record<string, unknown>, signal?: AbortSignal) {
		const response = await request(op, fields, {}, signal);
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		return result;
	}
	assert.equal((await fetch(endpoint)).status, 404);
	assert.equal((await request("state", {}, { Authorization: "wrong" })).status, 403);
	assert.equal((await request("state", {}, { Origin: "null" })).status, 403);
	assert.deepEqual((await call("state")).currentSession, starter);
	await call("loaded");
	await call("visibility", { visible: true });
	const read = await call("read", { doc });
	assert.equal(read.author, "Disk");
	let cursor: number;
	({ cursor } = await call("events", { since: 0 }));
	async function next<T extends PaneEvent["type"]>(type: T): Promise<Extract<PaneEvent, { type: T }>> {
		const signal = AbortSignal.timeout(4000);
		while (true) {
			const batch = await call("events", { since: cursor }, signal);
			cursor = batch.cursor;
			const event = (batch.events as PaneEvent[]).find((candidate) => candidate.type === type);
			if (event) return event as Extract<PaneEvent, { type: T }>;
		}
	}
	const departed = next("members");
	await opened.close();
	assert.deepEqual((await departed).members, []);
	assert.equal((await call("state")).currentSession, null);
	assert.equal(child.exitCode, null);
	assert.equal(await attached.command(doc), `Connected to Editor for ${root}.`);
	assert.deepEqual(await next("attach"), { type: "attach", participant: second, doc });
	assert.deepEqual((await call("state")).currentSession, second);
	assert.equal((await call("session", { id: null })).currentSession, null);
	assert.deepEqual((await call("session", { id: second.id })).currentSession, second);
	await writeFile(join(root, doc), "Direct\n");
	const direct = next("file");
	await attached.reportFile(join(root, doc), "modified");
	assert.deepEqual(await direct, { type: "file", path: doc, change: "modified", by: second, rev: read.rev + 1 });
	const adopted = await call("read", { doc });
	assert.equal(adopted.rev, read.rev + 1);
	assert.equal(adopted.text, "Direct\n");
	await attached.reportFile(join(root, doc), "modified");
	assert.deepEqual(await next("file"), { type: "file", path: doc, change: "modified", by: second });
	await writeFile(join(root, doc), "Other writer\n");
	assert.deepEqual(await next("file"), { type: "file", path: doc, change: "modified", rev: adopted.rev + 1 });
	assert.equal((await call("read", { doc })).text, "Other writer\n");
	const shown = next("show");
	assert.deepEqual(await attached.tool({ op: "show", doc, start: 0, end: 5, message: "Look here" }), { panes: 1 });
	assert.deepEqual(await shown, { type: "show", by: second, doc, start: 0, end: 5, message: "Look here" });
	proc.stdin.end();
	assert.deepEqual(await exit, [0, null]);
	await assert.rejects(call("state"));
	const store = new Workspace(root, agentDir);
	assert.equal(store.run({ op: "read", doc }, "You").text, "Other writer\n");
	store.close();
});
