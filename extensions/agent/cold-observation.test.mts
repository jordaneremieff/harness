import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureRuntime, eventLog, fixtureMetadata, waitForFixtureState, waitForProcessExit } from "./host-fixture.mts";
import { parseHostReadyLine } from "./host-protocol.ts";
import { fileURLToPath } from "node:url";
import { DurableHost } from "./durable-host.ts";
import { fixtureRuntime, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { it } from "node:test";
import { closeColdObservations, coldObservationMetrics, disposeColdStorage, observeColdStorage, openColdObservationSnapshot, resetColdObservationMetrics, type ColdObservationHooks } from "./cold-observation.ts";
import { runtimeFixture, waitForReceipt } from "./durable-runtime-fixture.mts";
import { acquireHost, connectHost } from "./host-client.ts";
import { Type } from "typebox";
import { hostPaths } from "./host-protocol.ts";
import { AgentConversationSummarySchema, ConversationStatusSchema, DurableInventorySchema, InspectOutputSchema, JsonValueSchema, ListRowSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";

/** Snapshot envelope consumed by the dashboard; native messages remain opaque JSON. */
const SnapshotPageSchema = Type.Object({
	entries: Type.Array(Type.Object({
		id: Type.String(), kind: Type.String(), head: Type.Optional(Type.String()),
		model: Type.Optional(Type.Array(JsonValueSchema)), data: Type.Optional(JsonValueSchema),
	}, { additionalProperties: false })),
	partial: Type.Boolean(), revision: Type.String(), nextBefore: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	coverage: Type.Object({
		complete: Type.Boolean(), entries: Type.Integer({ minimum: 0 }), bytes: Type.Integer({ minimum: 0 }),
		hiddenExcluded: Type.Integer({ minimum: 0 }), entryLimitReached: Type.Boolean(), byteLimitReached: Type.Boolean(),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

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
		await disposeColdStorage(metadata.storagePath);
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
			const timer = setTimeout(() => finish(new Error("runner readiness frame did not arrive")), 10000);
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
	resetColdObservationMetrics();
	let opens = 0;
	const hooks = { open: async (input: { storagePath: string; storageId: string }) => { opens += 1; return openColdObservationSnapshot(input); } };
	const first = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.equal(opens, 1);
	assert.equal(coldObservationMetrics().opens, 1);
	const second = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.deepEqual(second, first);
	assert.equal(opens, 1, "the unchanged source was not copied again");
	assert.equal(coldObservationMetrics().hits, 1);
	await closeColdObservations();
	const third = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks });
	assert.ok(third);
	assert.equal(opens, 2, "dispose forces a fresh snapshot");
	await disposeColdStorage(f.storagePath);
});

it("rejects a snapshot whose database identity changed during the open", async (t) => {
	const { f } = await coldSource(t);
	resetColdObservationMetrics();
	const hooks: ColdObservationHooks = {
		open: async (input) => {
			const handle = await openColdObservationSnapshot(input);
			const info = statSync(input.storagePath);
			utimesSync(input.storagePath, new Date(), new Date(info.mtimeMs + 5000));
			return handle;
		},
	};
	await assert.rejects(observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId }, { hooks }), /changed during the snapshot copy/u);
	assert.equal(coldObservationMetrics().opens, 0, "an unstable snapshot is not retained");
	await closeColdObservations();
});

it("reuses a real fresh closed database across two cold reads", async (t) => {
	const { f, exited } = await coldSource(t);
	await exited;
	resetColdObservationMetrics();
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(coldObservationMetrics().opens, 1);
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(coldObservationMetrics().opens, 1, "the second read reuses the closed database");
	await closeColdObservations();
});

it("invalidates the snapshot when the database or WAL identity changes", async (t) => {
	const { f } = await coldSource(t);
	resetColdObservationMetrics();
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(coldObservationMetrics().opens, 1);
	const info = statSync(f.storagePath);
	utimesSync(f.storagePath, new Date(), new Date(info.mtimeMs + 5000));
	await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.equal(coldObservationMetrics().opens, 2, "a changed database identity copies again");
	assert.equal(coldObservationMetrics().invalidations, 1);
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
	assert.equal(coldObservationMetrics().opens, 3, "a changed database identity copies again");
	assert.equal(coldObservationMetrics().invalidations, 2);
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
	resetColdObservationMetrics();
	const corruptPath = join(f.root, "corrupt.sqlite");
	writeFileSync(corruptPath, "not a sqlite database");
	await assert.rejects(observeColdStorage({ ...f.metadata, storagePath: corruptPath }, "status", {}), (error: unknown) => error instanceof Error);
	assert.equal(coldObservationMetrics().opens, 0, "a failed open is not retained");
	const valid = await observeColdStorage(f.metadata, "status", { sessionId: f.metadata.storageId });
	assert.ok(valid);
	await closeColdObservations();
});

it("serializes parallel cold reads beyond the cache bound and rejects a changed source", { timeout: 10000 }, async (t) => {
	await closeColdObservations();
	resetColdObservationMetrics();
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
		assert.equal(coldObservationMetrics().storages, 8);
		assert.equal(retained, 8);
		assert.equal(coldObservationMetrics().evictions, 4);
	} finally { await closeColdObservations(); }
	assert.equal(retained, 0);
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
	for (const row of listed.items) structuredObservation(Type.Omit(ListRowSchema, ["sessionId", "storageId", "cwd"]), row);
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
	structuredObservation(Type.Array(AgentConversationSummarySchema), dashboard);
	const after = statSync(f.storagePath, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.equal(existsSync(paths.claim), false, "cold reads never claim a writer");
	assert.equal(existsSync(paths.socket), false, "cold reads never launch a host");
	await closeColdObservations();
});
