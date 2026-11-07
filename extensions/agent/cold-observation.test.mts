import { str, int, bool, nul, union, arr, opt, obj } from "@earendil-works/pi-schema";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureRuntime, eventLog, fixtureMetadata, waitForFixtureState, waitForProcessExit } from "./host-fixture.mts";
import { parseHostReadyLine } from "./host-protocol.ts";
import { fileURLToPath } from "node:url";
import { DurableHost } from "./durable-host.ts";
import { fixtureRuntime, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { it, beforeEach, afterEach } from "node:test";
import { createColdObservationCache, openColdObservationSnapshot, type ColdObservationHooks, type ColdObservationOptions } from "./cold-observation.ts";
import type { HostMetadata } from "./host-protocol.ts";

let cache: ReturnType<typeof createColdObservationCache>;
let counts: { opens: number; reads: number; closes: number };
beforeEach(() => { cache = createColdObservationCache(); counts = { opens: 0, reads: 0, closes: 0 }; });
afterEach(async () => { await cache.close(); });
async function closeColdObservations() { await cache.close(); cache = createColdObservationCache(); }
async function observeColdStorage(metadata: HostMetadata, method: string, params: Record<string, unknown> = {}, options: ColdObservationOptions = {}): Promise<unknown> {
	return cache.observe(metadata, method, params, { hooks: { open: async (input) => {
		const handle = await (options.hooks?.open ?? openColdObservationSnapshot)(input);
		counts.opens++;
		return { request: async (method, params) => { counts.reads++; return handle.request(method, params); }, close: async () => { counts.closes++; await handle.close(); } };
	} } });
}
import { runtimeFixture, waitForReceipt } from "./durable-runtime-fixture.mts";
import { acquireHost, connectHost } from "./host-client.ts";
import { CommunicationViewSchema } from "./communication.ts";
import { hostPaths } from "./host-protocol.ts";
import { AgentConversationSummarySchema, ConversationStatusSchema, DurableInventorySchema, InspectOutputSchema, JsonValueSchema, NativeListRowSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";

/** Snapshot envelope consumed by the dashboard; native messages remain opaque JSON. */
const SnapshotPageSchema = obj({
	entries: arr(obj({
		id: str(), kind: str(), communication: CommunicationViewSchema, head: opt(str()),
		model: opt(arr(JsonValueSchema)), data: opt(JsonValueSchema),
	})),
	partial: bool(), revision: str(), nextBefore: union([int({ minimum: 1 }), nul()]),
	coverage: obj({
		complete: bool(), entries: int({ minimum: 0 }), bytes: int({ minimum: 0 }),
		hiddenExcluded: int({ minimum: 0 }), entryLimitReached: bool(), byteLimitReached: bool(),
	}),
});

it("rereads an absent storage that appears during its empty observation open", async () => {
	const root = mkdtempSync(join(tmpdir(), "cold-absent-"));
	const metadata = fixtureMetadata(root);
	let host: DurableHost | undefined;
	try {
		const first = await observeColdStorage(metadata, "snapshot", { sessionId: metadata.storageId }) as { entries: unknown[] };
		assert.deepEqual(first.entries, []);
		assert.equal(existsSync(metadata.storagePath), false);
		const emptyStatus = structuredObservation(StatusOutputSchema, await observeColdStorage(metadata, "status", {})) as { conversations: unknown[] };
		assert.deepEqual(emptyStatus.conversations, []);
		assert.equal(Object.hasOwn(emptyStatus, "inventory"), false);
		assert.equal(existsSync(metadata.storagePath), false);
		const raced = await observeColdStorage(metadata, "snapshot", { sessionId: metadata.storageId }, {
			hooks: { open: async (input) => {
				const empty = await openColdObservationSnapshot(input);
				host = await DurableHost.open({ ...hostOptions(metadata.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: metadata.storageId });
				const admitted = await host.submit({ message: "after storage appeared", requestId: "appeared", origin: "operator" });
				await host.wait(admitted.submissionId);
				return empty;
			} },
		}) as { entries: unknown[] };
		assert.deepEqual(raced.entries, [], "source creation during the absent open is not a snapshot error");
		assert.ok(host);
		await host.close();
		host = undefined;
		const next = await observeColdStorage(metadata, "snapshot", { sessionId: metadata.storageId });
		assert.match(JSON.stringify(next), /after storage appeared/);
	} finally {
		await host?.close();
		await cache.close();
		rmSync(root, { recursive: true, force: true });
	}
});

/** Build a real storage with one retained answer through the production runner. */
async function coldSource(t: { after(fn: () => void): void }) {
	const f = runtimeFixture(t);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./durable-runner.ts", import.meta.url)), JSON.stringify(f.metadata)], {
		cwd: f.cwd, env: { ...process.env, ...f.env("answer") }, stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { child.kill("SIGKILL"); });
	child.stderr?.on("data", () => {});
	const exited = waitForProcessExit(child, 30000);
	void exited.catch(() => {});
	await runnerReady(child);
	const primary = await connectHost(f.metadata);
	let submissionId: number;
	try {
		const submitted = await primary.request("submit", { message: "COLD_SOURCE", requestId: "cold-source", ownerId: f.ownerId, origin: "operator" }) as { submissionId: number };
		submissionId = submitted.submissionId;
		const receipt = await waitForReceipt(primary, f.ownerId, submissionId);
		assert.equal(receipt.status, "done");
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submissionId] });
	} finally {
		await primary.close().catch(() => undefined);
	}
	return { f, submissionId, exited };
}

/**
 * The production launch bound for runner readiness (`DEFAULT_LAUNCH_TIMEOUT_MS` in
 * host-client.ts). A directly spawned runner loads the same services and Agent
 * extension as an acquired host, so this stand-in fails no earlier than the product.
 */
const RUNNER_READINESS_MS = 30_000;

/** Resolve on the production runner's readiness frame, bounded only for failure. */
async function runnerReady(child: ChildProcess): Promise<void> {
	if (!child.stdout) throw new Error("runner has no readiness stream");
	const lines = createInterface({ input: child.stdout });
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error): void => {
				clearTimeout(timer);
				lines.off("line", onLine);
				child.off("exit", onExit);
				child.off("error", onError);
				if (error) reject(error);
				else resolve();
			};
			const onLine = (line: string): void => {
				try { if (parseHostReadyLine(line)) finish(); }
				catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			};
			const onExit = (): void => finish(new Error("runner exited before readiness"));
			const onError = (error: Error): void => finish(error);
			const timer = setTimeout(() => finish(new Error(`runner readiness frame did not arrive within ${RUNNER_READINESS_MS} ms`)), RUNNER_READINESS_MS);
			lines.on("line", onLine);
			child.once("exit", onExit);
			child.once("error", onError);
		});
	} finally { lines.close(); }
	child.stdout.on("data", () => {});
}

it("keeps fixture event consumers pending before the producer records its event", async () => {
	const events = eventLog<number>();
	let completed = false;
	const pending = events.waitForCount(1).then(() => { completed = true; });
	assert.equal(completed, false);
	events.push(1);
	await pending;
	assert.equal(completed, true);
	await events.waitForCount(1);
});

it("keeps a fixture receipt pending until its release protocol request", async (t) => {
	const f = runtimeFixture(t);
	const path = join(f.root, "state.json");
	const runtime = createFixtureRuntime(path);
	const observed = {
		subscribeChanges: async (listener: () => void) => {
			const unsubscribe = runtime.onChange?.(listener) ?? (() => {});
			listener();
			return unsubscribe;
		},
	};
	let stateReached = false;
	const state = waitForFixtureState(observed, path, (value) => (value.waitsStarted ?? 0) >= 1).then(() => { stateReached = true; });
	assert.equal(stateReached, false);
	let released = false;
	const receipt = runtime.request("receipts", {}, "held").then(() => { released = true; });
	await state;
	assert.equal(released, false);
	await runtime.request("timer-cancel", {}, "release");
	await receipt;
	assert.equal(released, true);
	await runtime.close();
});

it("keeps an owned process exit consumer pending until the child exits", async (t) => {
	const child = spawn(process.execPath, ["-e", "process.stdout.write('held\\n'); process.stdin.once('data', () => process.exit(0));"], { stdio: ["pipe", "pipe", "ignore"] });
	t.after(() => { child.kill("SIGKILL"); });
	const held = eventLog<string>();
	const lines = createInterface({ input: child.stdout });
	t.after(() => lines.close());
	lines.on("line", (line) => held.push(line));
	let exited = false;
	const pending = waitForProcessExit(child).then(() => { exited = true; });
	await held.waitForCount(1);
	assert.deepEqual(held, ["held"]);
	assert.equal(exited, false);
	child.stdin.end("release");
	await pending;
	assert.equal(exited, true);
});

it("reuses one snapshot and result for an unchanged source", async (t) => {
	const { f } = await coldSource(t);
	let opens = 0;
	const hooks = { open: async (input: { storagePath: string; storageId: string }) => { opens += 1; return openColdObservationSnapshot(input); } };
	const first = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.equal(opens, 1);
	assert.equal(counts.opens, 1);
	const second = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.deepEqual(second, first);
	assert.equal(opens, 1, "the unchanged source was not copied again");
	assert.equal(counts.reads, 1);
	await closeColdObservations();
	const third = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.ok(third);
	assert.equal(opens, 2, "dispose forces a fresh snapshot");
	await cache.close();
});

it("rejects a snapshot whose database identity changed during the open", async (t) => {
	const { f } = await coldSource(t);
	const hooks: ColdObservationHooks = {
		open: async (input) => {
			const handle = await openColdObservationSnapshot(input);
			const info = statSync(input.storagePath);
			utimesSync(input.storagePath, new Date(), new Date(info.mtimeMs + 5000));
			return handle;
		},
	};
	await assert.rejects(observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks }), /changed during the snapshot copy/u);
	assert.equal(counts.closes, 1, "an unstable snapshot is closed");
	await closeColdObservations();
});

it("reuses a real fresh closed database across two cold reads", async (t) => {
	const { f, exited } = await coldSource(t);
	await exited;
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(counts.opens, 1);
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(counts.opens, 1, "the second read reuses the closed database");
	await closeColdObservations();
});

it("invalidates the snapshot when the database or WAL identity changes", async (t) => {
	const { f } = await coldSource(t);
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(counts.opens, 1);
	const info = statSync(f.storagePath);
	utimesSync(f.storagePath, new Date(), new Date(info.mtimeMs + 5000));
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(counts.opens, 2, "a changed database identity copies again");
	assert.equal(counts.closes, 1);
	// A real second run mutates the source; a fresh copy picks up the new entry.
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	try {
		const submitted = await primary.request("submit", { message: "COLD_SECOND", requestId: "cold-second", ownerId: f.ownerId, origin: "operator" }) as { submissionId: number };
		await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
	} finally {
		await primary.close().catch(() => undefined);
	}
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(counts.opens, 3, "a changed database identity copies again");
	assert.equal(counts.closes, 2);
	const found = await observeColdStorage(f.metadata, "inspect", { view: "search", sessionId: f.metadata.storageId, query: "COLD_SECOND" }) as { matches: unknown[] };
	assert.ok(found.matches.length >= 1, "the fresh snapshot contains the new entry");
	await closeColdObservations();
});

it("leaves the source database and WAL unchanged", async (t) => {
	const { f } = await coldSource(t);
	const walPath = `${f.storagePath}-wal`;
	const dbBefore = statSync(f.storagePath, { bigint: true });
	const walBefore = existsSync(walPath) ? statSync(walPath, { bigint: true }) : undefined;
	await observeColdStorage(f.metadata, "inspect", { view: "history", sessionId: f.metadata.storageId, limit: 10 });
	await observeColdStorage(f.metadata, "snapshot", { sessionId: f.metadata.storageId });
	const dbAfter = statSync(f.storagePath, { bigint: true });
	assert.equal(dbAfter.ino, dbBefore.ino);
	assert.equal(dbAfter.size, dbBefore.size);
	assert.equal(dbAfter.mtimeNs, dbBefore.mtimeNs);
	const walAfter = existsSync(walPath) ? statSync(walPath, { bigint: true }) : undefined;
	assert.equal(walAfter?.ino, walBefore?.ino);
	assert.equal(walAfter?.size, walBefore?.size);
	assert.equal(walAfter?.mtimeNs, walBefore?.mtimeNs);
	await closeColdObservations();
});

it("rejects a corrupt source without caching it", async (t) => {
	const { f } = await coldSource(t);
	const corruptPath = join(f.root, "corrupt.sqlite");
	writeFileSync(corruptPath, "not a sqlite database");
	await assert.rejects(observeColdStorage({ ...f.metadata, storagePath: corruptPath }, "status", {}), (error: unknown) => error instanceof Error);
	assert.equal(counts.opens, 0, "a failed open is not retained");
	const valid = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.ok(valid);
	await closeColdObservations();
});

it("serializes parallel cold reads beyond the cache bound and rejects a changed source", { timeout: 10000 }, async (t) => {
	await closeColdObservations();
	const f = runtimeFixture(t);
	let retained = 0;
	let active = 0;
	let peak = 0;
	const hooks: ColdObservationHooks = {
		open: async ({ storagePath }) => {
			let closed = false;
			retained++;
			if (storagePath.endsWith("changed.sqlite")) writeFileSync(storagePath, "changed content");
			return {
				request: async () => {
					active++;
					peak = Math.max(peak, active);
					await Promise.resolve();
					assert.equal(closed, false, "eviction never closes a borrowed snapshot");
					active--;
					return { storagePath };
				},
				close: async () => { assert.equal(closed, false); closed = true; retained--; },
			};
		},
	};
	try {
		const paths = Array.from({ length: 13 }, (_, index) => join(f.root, index === 12 ? "changed.sqlite" : `parallel-${index}.sqlite`));
		for (const path of paths) writeFileSync(path, "original");
		const results = await Promise.allSettled(paths.map((storagePath) => observeColdStorage({ ...f.metadata, storagePath }, "snapshot", {}, { hooks })));
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 12);
		const rejected = results[12];
		assert.equal(rejected?.status, "rejected");
		if (rejected?.status === "rejected") assert.match(String(rejected.reason), /changed during the snapshot copy/u);
		assert.equal(peak, 1);
		assert.equal(retained, 8);
		assert.equal(counts.closes, 5, "four evictions and one unstable copy");
	} finally { await closeColdObservations(); }
	assert.equal(retained, 0);
});

it("drains a borrowed snapshot on close without closing another cache owner's snapshot", async (t) => {
	const f = runtimeFixture(t);
	writeFileSync(f.storagePath, "stable synthetic source");
	const peer = createColdObservationCache();
	t.after(() => peer.close());
	let release!: () => void, started!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const borrowed = new Promise<void>((resolve) => { started = resolve; });
	let closes = 0, peerCloses = 0;
	const hooks: ColdObservationHooks = { open: async () => ({ request: async () => { started(); await held; assert.equal(closes, 0); return "borrowed"; }, close: async () => { closes++; } }) };
	const peerHooks: ColdObservationHooks = { open: async () => ({ request: async () => "peer", close: async () => { peerCloses++; } }) };
	assert.equal(await peer.observe(f.metadata, "snapshot", {}, { hooks: peerHooks }), "peer");
	const read = cache.observe(f.metadata, "snapshot", {}, { hooks });
	await borrowed;
	let settled = false;
	const closing = cache.close().then(() => { settled = true; });
	assert.equal(settled, false);
	assert.equal(closes, 0);
	release(); assert.equal(await read, "borrowed"); await closing;
	assert.equal(closes, 1);
	assert.equal(peerCloses, 0);
	assert.equal(await peer.observe(f.metadata, "snapshot", {}, { hooks: peerHooks }), "peer");
	await assert.rejects(cache.observe(f.metadata, "snapshot"), /cache is closed/);
	await peer.close(); assert.equal(peerCloses, 1);
});

it("validates real retired storage status, every inspect view, snapshot and dashboard", async (t) => {
	const { f, submissionId, exited } = await coldSource(t);
	await exited;
	const paths = hostPaths(f.metadata);
	assert.equal(existsSync(paths.claim), false);
	assert.equal(existsSync(paths.socket), false);
	const before = statSync(f.storagePath, { bigint: true });
	t.after(() => closeColdObservations());
	const sessionId = f.metadata.storageId;
	const history = await observeColdStorage(f.metadata, "inspect", { view: "history", sessionId, limit: 10 }) as { view: string; entries: Array<{ id: string }> };
	assert.equal(history.view, "history");
	assert.ok(history.entries.length >= 1);
	const branch = await observeColdStorage(f.metadata, "inspect", { view: "branch", sessionId, limit: 10 }) as { view: string };
	assert.equal(branch.view, "branch");
	const search = await observeColdStorage(f.metadata, "inspect", { view: "search", sessionId, query: "COLD_SOURCE" }) as { view: string; matches: unknown[] };
	assert.equal(search.view, "search");
	assert.ok(search.matches.length >= 1);
	const activity = await observeColdStorage(f.metadata, "inspect", { view: "activity", sessionId }) as { view: string };
	assert.equal(activity.view, "activity");
	const exact = await observeColdStorage(f.metadata, "inspect", { view: "exact", sessionId, entryId: history.entries[0]?.id }) as { view: string };
	assert.equal(exact.view, "exact");
	const result = await observeColdStorage(f.metadata, "inspect", { view: "result", sessionId, submissionId }) as { view: string };
	assert.equal(result.view, "result");
	for (const value of [history, branch, search, activity, exact, result]) structuredObservation(InspectOutputSchema, value);
	const listed = await observeColdStorage(f.metadata, "list", {}) as { items: unknown[] };
	assert.ok(Array.isArray(listed.items));
	for (const row of listed.items) structuredObservation(NativeListRowSchema, row);
	const status = await observeColdStorage(f.metadata, "status", { sessionId }) as { conversation?: unknown; live?: boolean; storageId?: string };
	structuredObservation(StatusOutputSchema, status);
	assert.equal(status.live, false);
	assert.equal(status.storageId, f.metadata.storageId);
	assert.ok(status.conversation);
	assert.equal(Object.hasOwn(status, "inventory"), false, "a retired host has no loaded inventory to report");
	assert.equal(Object.hasOwn(status, "pid"), false);
	structuredObservation(ConversationStatusSchema, status.conversation);
	const aggregate = await observeColdStorage(f.metadata, "status", {}) as { conversations: unknown[] };
	structuredObservation(StatusOutputSchema, aggregate);
	assert.equal(aggregate.conversations.length, 1);
	assert.equal(Object.hasOwn(aggregate, "inventory"), false);
	const inventory = structuredObservation(DurableInventorySchema, { contributions: [], ordinaryOnly: [] });
	assert.throws(() => structuredObservation(StatusOutputSchema, { ...status, inventory }), /does not match its schema/u, "cold status must not fabricate an empty loaded inventory");
	assert.throws(() => structuredObservation(StatusOutputSchema, { ...status, live: undefined, pid: process.pid }), /does not match its schema/u, "live host status still requires inventory");
	const snapshot = await observeColdStorage(f.metadata, "snapshot", { sessionId });
	structuredObservation(SnapshotPageSchema, snapshot);
	const dashboard = await observeColdStorage(f.metadata, "dashboard", {});
	structuredObservation(arr(AgentConversationSummarySchema), dashboard);
	const after = statSync(f.storagePath, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.equal(existsSync(paths.claim), false, "cold reads never claim a writer");
	assert.equal(existsSync(paths.socket), false, "cold reads never launch a host");
	await closeColdObservations();
});

it("loads the native observation runtime only when opening a real cold snapshot", () => {
	const script = `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const loaded = [];
		registerHooks({ load(url, context, next) {
			if (url.endsWith("/durable-observation.ts")) loaded.push(url);
			return next(url, context);
		} });
		const { createColdObservationCache } = await import(${JSON.stringify(new URL("./cold-observation.ts", import.meta.url).href)});
		const cache = createColdObservationCache();
		assert.deepEqual(loaded, []);
		const value = await cache.observe(
			{ storagePath: "/tmp/nonexistent-cold-storage.sqlite", storageId: "cold-hook", cwd: "/tmp", agentDir: "/tmp", packageDir: "/tmp", model: { provider: "p", modelId: "m" }, thinkingLevel: "off" },
			"status",
			{},
			{ hooks: { open: async () => ({ request: async () => ({ conversations: [] }), close: async () => {} }) } },
		);
		assert.deepEqual(loaded, []);
		assert.equal((value).storageId, "cold-hook");
		await cache.close();
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
});

