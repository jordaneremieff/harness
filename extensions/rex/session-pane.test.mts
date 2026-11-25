import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSessionPaneRegistrar,
	launchPane,
	readSessionPane,
	registerSessionPane,
	releaseSessionPane,
	sessionPaneDirectory,
} from "./session-pane.ts";

const session = "session:11111111-1111-4111-8111-111111111111";
const block = "block:33333333-3333-4333-8333-333333333333";
const otherBlock = "block:55555555-5555-4555-8555-555555555555";
const server = "unix:///rex/server.sock";
const env = { REX_SERVER: server, REX_BLOCK: block };

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "rex-session-pane-"));
	try {
		await run(agentDir);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

function recordFile(agentDir: string, sessionId: string): string {
	return join(sessionPaneDirectory(agentDir), `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

test("a launch environment names a pane only with an exact block", () => {
	assert.deepEqual(launchPane(env), { server, block });
	assert.deepEqual(launchPane({ ...env, REX_SERVER: "" }), { block }, "an empty server is no server");
	assert.deepEqual(
		launchPane({ ...env, REX_SESSION: session }),
		{ server, block },
		"a launch session is not part of the pane: the block's tab can move to another session",
	);
	assert.equal(launchPane({ REX_SESSION: session }), undefined, "a session without a block names no pane");
	assert.equal(launchPane({ ...env, REX_BLOCK: "work" }), undefined, "a label is not a block ID");
	assert.equal(launchPane({ ...env, REX_SERVER: "bad\nserver" }), undefined);
});

test("a registered pane reads back while its process runs, and private files hold it", async () =>
	withAgentDir(async (agentDir) => {
		registerSessionPane({
			agentDir,
			sessionId: "ordinary-1",
			pid: 101,
			pane: { server, block },
			now: new Date("2026-11-18T00:00:00.000Z"),
			alive: () => true,
		});
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary-1", (pid) => pid === 101),
			{ ok: true, pane: { server, block } },
		);
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary-1", () => false),
			{ ok: false, reason: "ended" },
		);
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary-2", () => true),
			{ ok: false, reason: "unregistered" },
		);
		const path = recordFile(agentDir, "ordinary-1");
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			version: 2,
			sessionId: "ordinary-1",
			pid: 101,
			server,
			block,
			updatedAt: "2026-11-18T00:00:00.000Z",
		});
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(sessionPaneDirectory(agentDir))).mode & 0o777, 0o700);
		registerSessionPane({
			agentDir,
			sessionId: "ordinary-1",
			pid: 102,
			pane: { block: otherBlock },
			alive: () => true,
		});
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary-1", () => true),
			{ ok: true, pane: { block: otherBlock } },
			"a later process of the same session replaces the record",
		);
	}));

test("records that are not exact current records read as unregistered", async () =>
	withAgentDir(async (agentDir) => {
		registerSessionPane({ agentDir, sessionId: "ordinary", pid: 101, pane: { block }, alive: () => true });
		const path = recordFile(agentDir, "ordinary");
		const valid = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		for (const invalid of [
			{ ...valid, extra: true },
			{ ...valid, session },
			{ ...valid, version: 1 },
			{ ...valid, sessionId: "other" },
			{ ...valid, block: "work" },
			{ ...valid, pid: 0 },
		]) {
			await writeFile(path, JSON.stringify(invalid));
			assert.deepEqual(
				readSessionPane(agentDir, "ordinary", () => true),
				{ ok: false, reason: "unregistered" },
				JSON.stringify(invalid),
			);
		}
		await writeFile(path, "{");
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary", () => true),
			{ ok: false, reason: "unregistered" },
		);
	}));

test("release removes a session's record only while it names the releasing process", async () =>
	withAgentDir(async (agentDir) => {
		registerSessionPane({ agentDir, sessionId: "ordinary", pid: 101, pane: { block }, alive: () => true });
		releaseSessionPane({ agentDir, sessionId: "ordinary", pid: 202 });
		assert.equal(
			readSessionPane(agentDir, "ordinary", () => true).ok,
			true,
			"another process's release leaves the record",
		);
		releaseSessionPane({ agentDir, sessionId: "ordinary", pid: 101 });
		assert.deepEqual(
			readSessionPane(agentDir, "ordinary", () => true),
			{ ok: false, reason: "unregistered" },
		);
		releaseSessionPane({ agentDir, sessionId: "ordinary", pid: 101 });
	}));

test("a registration removes records of ended processes, invalid records and stale temporary files", async () =>
	withAgentDir(async (agentDir) => {
		const now = new Date("2026-11-18T00:00:00.000Z");
		registerSessionPane({ agentDir, sessionId: "ended", pid: 301, pane: { block }, now, alive: () => true });
		registerSessionPane({ agentDir, sessionId: "running", pid: 302, pane: { block }, now, alive: () => true });
		const directory = sessionPaneDirectory(agentDir);
		const invalid = join(directory, `${"a".repeat(64)}.json`);
		await writeFile(invalid, "not a record");
		const staleTemporary = join(directory, ".tmp-00000000-0000-4000-8000-000000000000");
		const freshTemporary = join(directory, ".tmp-11111111-1111-4111-8111-111111111111");
		await writeFile(staleTemporary, "partial");
		await writeFile(freshTemporary, "partial");
		await utimes(staleTemporary, new Date("2026-11-16T00:00:00.000Z"), new Date("2026-11-16T00:00:00.000Z"));
		await utimes(freshTemporary, now, now);
		const unrelated = join(directory, "notes.txt");
		await writeFile(unrelated, "kept");
		registerSessionPane({
			agentDir,
			sessionId: "new",
			pid: 303,
			pane: { block },
			now,
			alive: (pid) => pid !== 301,
		});
		const names = new Set(await readdir(directory));
		assert.equal(readSessionPane(agentDir, "ended", () => true).ok, false, "a record of an ended process is removed");
		assert.equal(readSessionPane(agentDir, "running", () => true).ok, true);
		assert.equal(readSessionPane(agentDir, "new", () => true).ok, true);
		assert.equal(names.has(`${"a".repeat(64)}.json`), false, "an invalid record is removed");
		assert.equal(
			names.has(".tmp-00000000-0000-4000-8000-000000000000"),
			false,
			"a temporary file older than a day is removed",
		);
		assert.equal(
			names.has(".tmp-11111111-1111-4111-8111-111111111111"),
			true,
			"a recent temporary file can belong to a running write",
		);
		assert.equal(names.has("notes.txt"), true, "files that are not records stay");
	}));

test("the registrar records interactive sessions in Rex panes and releases each session it recorded", async () =>
	withAgentDir(async (agentDir) => {
		let sessionId = "first";
		const ctx = (mode: string) => ({ mode, sessionManager: { getSessionId: () => sessionId } }) as never;
		const registrar = createSessionPaneRegistrar({ agentDir, env, pid: process.pid });
		registrar.start(ctx("tui"));
		assert.deepEqual(readSessionPane(agentDir, "first"), { ok: true, pane: { server, block } });
		sessionId = "second";
		registrar.start(ctx("tui"));
		assert.deepEqual(
			readSessionPane(agentDir, "first"),
			{ ok: false, reason: "unregistered" },
			"a session switch releases the earlier session's record",
		);
		assert.equal(readSessionPane(agentDir, "second").ok, true);
		registrar.shutdown();
		assert.deepEqual(readSessionPane(agentDir, "second"), { ok: false, reason: "unregistered" });
		sessionId = "headless";
		registrar.start(ctx("rpc"));
		assert.deepEqual(
			readSessionPane(agentDir, "headless"),
			{ ok: false, reason: "unregistered" },
			"a session without a terminal pane records nothing",
		);
		createSessionPaneRegistrar({ agentDir, env: { REX_SERVER: server }, pid: process.pid }).start(ctx("tui"));
		assert.deepEqual(
			readSessionPane(agentDir, "headless"),
			{ ok: false, reason: "unregistered" },
			"a process outside a Rex pane records nothing",
		);
		assert.doesNotThrow(() =>
			createSessionPaneRegistrar({ agentDir, env, pid: process.pid }).start({
				mode: "tui",
				sessionManager: {
					getSessionId: () => {
						throw new Error("no session");
					},
				},
			} as never),
		);
	}));
