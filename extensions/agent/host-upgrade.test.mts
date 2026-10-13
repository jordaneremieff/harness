import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import type { RuntimeContract } from "./version-contract.ts";

interface Source { root: string; packageDir: string; codingAgent: string; durable: string }
interface Event { kind: string; id?: number; pid?: number; contract?: RuntimeContract; result?: unknown; error?: string; output?: string }
interface Receipt { submissionId: number; status: string; answer?: string }
interface Retained { answerEntryId: number; answer: string; submissionId: number; [key: string]: unknown }
const sourceFiles = ["durable-runner.ts", "host-client.ts", "host-protocol.ts", "host-fixture.mts", "testdata/durable-runtime/caller-continuity.ts"];
function metadata(path: string, name: string): { version: string } {
	assert.ok(statSync(path).size <= 32768, "Package metadata must remain bounded");
	const value = JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
	assert.equal(value.name, name);
	assert.match(value.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
	return value;
}
type StoredRow = Record<string, SQLOutputValue>;
function retainedStorage(path: string) {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const read = (sql: string): StoredRow[] => {
			const rows = database.prepare(sql).all();
			assert.ok(rows.length <= 5000 && Buffer.byteLength(JSON.stringify(rows)) <= 1024 * 1024, "Synthetic storage inspection must remain bounded");
			return rows;
		};
		return {
			schema: read("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT 5001"),
			version: read("SELECT * FROM durable_schema LIMIT 2"),
			entries: read("SELECT * FROM entries ORDER BY id LIMIT 5001"),
			tasks: read("SELECT * FROM tasks ORDER BY id LIMIT 5001"),
			submissions: read("SELECT * FROM submissions ORDER BY id LIMIT 5001"),
			revisions: read("SELECT * FROM document_revisions ORDER BY document_id, seq LIMIT 5001"),
		};
	} finally { database.close(); }
}
function discover(root: string, packageDir: string): Source {
	root = realpathSync(root); packageDir = realpathSync(packageDir);
	metadata(join(root, "package.json"), "harness");
	for (const file of sourceFiles) assert.ok(statSync(join(root, "extensions", "agent", file)).isFile(), `Required source: ${file}`);
	const require = createRequire(join(root, "package.json"));
	const durable = metadata(require.resolve("@earendil-works/pi-durable/package.json"), "@earendil-works/pi-durable").version;
	const codingAgent = metadata(join(packageDir, "package.json"), "@earendil-works/pi-coding-agent").version;
	assert.equal(durable, codingAgent, "Each runtime fixture requires one coherent upstream release");
	return { root, packageDir, codingAgent, durable };
}

it("drains old native tool work before a fresh runtime reopens retained results", { timeout: 120000 }, async (t) => {
	const oldRoot = process.env.PI_AGENT_TEST_OLD_SOURCE;
	const oldPackage = process.env.PI_AGENT_TEST_OLD_PACKAGE;
	if (!oldRoot || !oldPackage) {
		t.skip("requires a retained runtime through PI_AGENT_TEST_OLD_SOURCE and PI_AGENT_TEST_OLD_PACKAGE"); return;
	}
	if (!existsSync(join(oldRoot, "package.json")) || !existsSync(join(oldPackage, "package.json"))) {
		t.skip("the configured retained source or Pi installation is unavailable"); return;
	}
	const old = discover(oldRoot, oldPackage);
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const require = createRequire(import.meta.url);
	const next = discover(root, process.env.PI_AGENT_TEST_NEW_PACKAGE ?? dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")));
	assert.notEqual(old.root, next.root, "Source roots must remain isolated");
	assert.notEqual(old.durable, next.durable, "The regression requires different upstream releases");
	const { runtimeFixture, markerFixture } = await import("./durable-runtime-fixture.mts");
	const { eventLog, waitForProcessExit } = await import("./host-fixture.mts");
	const f = runtimeFixture(t, { packageDir: old.packageDir });
	const barrier = markerFixture(t, f.testDir);
	const release = barrier.hold("continuity-blocked");
	const clients: Array<{ child: ChildProcess; request(method: string, params?: unknown): Promise<unknown>; ready: Event }> = [];
	const settings = (source: Source) => writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({
		extensions: [join(source.root, "extensions", "agent", "testdata", "durable-runtime", "caller-continuity.ts")],
		cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
	}));
	async function start(source: Source) {
		settings(source);
		const events = eventLog<Event>();
		const child = spawn(process.execPath, [fileURLToPath(new URL("./host-upgrade-client-fixture.mts", import.meta.url)), JSON.stringify({
			sourceRoot: source.root, syntheticRoot: realpathSync(f.root), metadata: { ...f.metadata, packageDir: source.packageDir },
		})], { cwd: f.cwd, env: {
			PATH: process.env.PATH, HOME: f.agentDir, PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root,
			PI_PACKAGE_DIR: source.packageDir, PI_AGENT_IDLE_MINUTES: "0", DURABLE_TEST_DIR: f.testDir,
			DURABLE_TEST_CHILD_CWD: f.childCwd, DURABLE_TEST_NOTIFY: barrier.notifyPath,
		}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let output = "";
		const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536); };
		child.stdout?.on("data", append); child.stderr?.on("data", append);
		child.on("message", (value) => events.push(value as Event));
		child.on("error", (error) => events.push({ kind: "failed", error: String(error) }));
		child.on("exit", () => events.push({ kind: "exit" }));
		t.after(async () => {
			if (child.connected) child.disconnect();
			try { await waitForProcessExit(child, 10000); }
			catch { child.kill("SIGKILL"); await waitForProcessExit(child); }
		});
		await events.waitFor((rows) => rows.some((row) => row.kind === "ready" || row.kind === "failed" || row.kind === "exit"), 30000);
		const ready = events.find((row) => row.kind === "ready");
		assert.ok(ready?.contract, `Control process failed: ${JSON.stringify(events)}\n${output}`);
		assert.deepEqual(ready.contract.upstream, { codingAgent: source.codingAgent, durable: source.durable });
		assert.equal(ready.contract.operations.status.durable, source.durable);
		let id = 0;
		const client = { child, ready, request: async (method: string, params?: unknown) => {
			const current = ++id;
			child.send({ id: current, method, params });
			await events.waitFor((rows) => rows.some((row) => row.id === current || row.kind === "exit"), 30000);
			const event = events.find((row) => row.id === current);
			assert.ok(event && event.kind === "result", `Control ${method} failed: ${JSON.stringify(event)}\n${output}`);
			return event.result;
		} };
		clients.push(client); return client;
	}
	async function complete(client: Awaited<ReturnType<typeof start>>, submissionId: number): Promise<Receipt> {
		const response = await client.request("receipts", { ownerId: f.ownerId, wait: true }) as { receipts: Receipt[] };
		const receipt = response.receipts.find((row) => row.submissionId === submissionId);
		assert.ok(receipt); assert.equal(receipt.status, "done");
		await client.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submissionId] });
		assert.deepEqual(await client.request("drain"), { workPending: false, deliveriesPending: false, deliveriesActive: false });
		const status = await client.request("status", { sessionId: f.metadata.storageId }) as { conversation: { busy: boolean; tasks: unknown[] } };
		assert.equal(status.conversation.busy, false); assert.deepEqual(status.conversation.tasks, []);
		return receipt;
	}
	try {
		const first = await start(old);
		const submitted = await first.request("submit", { message: "CONTINUITY_CHILD", requestId: "upgrade-original", ownerId: f.ownerId, origin: "operator" }) as { submissionId: number };
		await barrier.marker("continuity-blocked");
		const blocked = await first.request("status", { sessionId: f.metadata.storageId }) as { conversation: { busy: boolean; tasks: { kind: string }[] } };
		assert.equal(blocked.conversation.busy, true);
		assert.ok(blocked.conversation.tasks.some((task) => task.kind === "pi.tool"), "Old native tool tasks must exist before drain");
		release();
		assert.equal((await complete(first, submitted.submissionId)).answer, "RETAINED_X");
		const before = await first.request("inspect", { view: "result", submissionId: submitted.submissionId }) as Retained;
		assert.ok(before.answerEntryId); assert.equal(before.answer, "RETAINED_X");
		assert.deepEqual(await first.request("close-host"), { pid: first.ready.pid, exited: true, claimReleased: true });
		first.child.disconnect(); await waitForProcessExit(first.child);
		const storedBefore = retainedStorage(f.storagePath);
		assert.deepEqual(storedBefore.version.map((row) => row.version), [1]);
		assert.ok(storedBefore.tasks.every((row) => row.status === "terminal"), "No live old task reaches the new scheduler");
		const second = await start(next);
		const storedAfter = retainedStorage(f.storagePath);
		assert.deepEqual(storedAfter.schema, storedBefore.schema, "Open does not migrate the SQLite format");
		assert.deepEqual(storedAfter.version, storedBefore.version);
		for (const table of ["entries", "tasks", "submissions", "revisions"] as const) {
			const key = (row: StoredRow) => table === "revisions" ? `${row.document_id}:${row.seq}` : String(row.id);
			const retainedKeys = new Set(storedBefore[table].map(key));
			assert.deepEqual(storedAfter[table].filter((row) => retainedKeys.has(key(row))), storedBefore[table], `Open preserves existing ${table} records`);
		}
		assert.notEqual(second.ready.pid, first.ready.pid);
		assert.notEqual(second.ready.contract?.operations.status.durable, first.ready.contract?.operations.status.durable);
		const after = await second.request("inspect", { view: "result", submissionId: submitted.submissionId }) as Retained;
		assert.deepEqual(after, before, "A drained transition preserves the exact retained result");
		const followup = await second.request("submit", { message: "CONTINUITY_FOLLOWUP", requestId: "upgrade-followup", ownerId: f.ownerId, origin: "operator" }) as { submissionId: number };
		assert.notEqual(followup.submissionId, submitted.submissionId);
		assert.equal((await complete(second, followup.submissionId)).answer, "FOLLOWUP_X");
		const retained = await second.request("inspect", { view: "result", submissionId: submitted.submissionId }) as Retained;
		const stable = ({ usage: _usage, ...value }: Retained) => value;
		assert.deepEqual(stable(retained), stable(before));
		await second.request("close-host");
		const trace = join(f.testDir, "continuity.jsonl");
		assert.ok(statSync(trace).size <= 65536);
		const rows = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; pid: number; packageDir: string });
		assert.equal(rows.filter((row) => row.kind === "tool-enter").length, 1);
		assert.equal(rows.filter((row) => row.kind === "tool-release").length, 1);
		assert.equal(rows.filter((row) => row.kind === "tool-abort").length, 0);
		for (const [client, source] of [[first, old], [second, next]] as const) {
			const binding = rows.find((row) => row.kind === "host-binding" && row.pid === client.ready.pid);
			assert.ok(binding); assert.equal(realpathSync(binding.packageDir), source.packageDir);
		}
		t.diagnostic(`Drained transition: Pi/Durable ${old.durable} -> ${next.durable}; old writer exited before new open; unchanged SQLite schema and retained rows; one tool effect, zero aborts`);
	} finally {
		release();
		for (const client of clients) {
			if (client.child.connected) client.child.disconnect();
			await waitForProcessExit(client.child).catch(() => { client.child.kill("SIGKILL"); });
		}
	}
});

