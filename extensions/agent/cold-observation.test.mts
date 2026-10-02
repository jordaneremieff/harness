import assert from "node:assert/strict";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { closeColdObservations, coldObservationMetrics, disposeColdStorage, observeColdStorage, openColdObservationSnapshot, resetColdObservationMetrics, type ColdObservationHooks } from "./cold-observation.ts";
import { runtimeFixture, waitForReceipt } from "./durable-runtime-fixture.mts";
import { acquireHost } from "./host-client.ts";

/** Build a real storage with one retained answer through the production runner. */
async function coldSource(t: { after(fn: () => void): void }) {
	const f = runtimeFixture(t);
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	const pid = primary.pid;
	let submissionId: number;
	try {
		const submitted = await primary.request("submit", { message: "COLD_SOURCE", requestId: "cold-source", ownerId: f.ownerId }) as { submissionId: number };
		submissionId = submitted.submissionId;
		const receipt = await waitForReceipt(primary, f.ownerId, submissionId);
		assert.equal(receipt.status, "done");
	} finally {
		await primary.close().catch(() => undefined);
	}
	return { f, submissionId, pid };
}

/** Wait for a retired host process, bounded. */
async function waitForExit(pid: number, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { process.kill(pid, 0); } catch { return; }
		if (Date.now() >= deadline) throw new Error("host did not exit before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

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
	const { f, pid } = await coldSource(t);
	await waitForExit(pid);
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
		const submitted = await primary.request("submit", { message: "COLD_SECOND", requestId: "cold-second", ownerId: f.ownerId }) as { submissionId: number };
		await waitForReceipt(primary, f.ownerId, submitted.submissionId);
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

it("rejects a missing or corrupt source without caching it", async (t) => {
	const { f } = await coldSource(t);
	resetColdObservationMetrics();
	await assert.rejects(observeColdStorage({ ...f.metadata, storagePath: join(f.root, "missing.sqlite") }, "status", {}), (error: unknown) => error instanceof Error);
	assert.equal(coldObservationMetrics().opens, 0, "a failed open is not retained");
	const corruptPath = join(f.root, "corrupt.sqlite");
	writeFileSync(corruptPath, "not a sqlite database");
	await assert.rejects(observeColdStorage({ ...f.metadata, storagePath: corruptPath }, "status", {}), (error: unknown) => error instanceof Error);
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

it("preserves the cold inspection and snapshot schemas", async (t) => {
	const { f, submissionId } = await coldSource(t);
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
	const listed = await observeColdStorage(f.metadata, "list", {}) as { items: unknown[] };
	assert.ok(Array.isArray(listed.items));
	const status = await observeColdStorage(f.metadata, "status", { sessionId }) as { conversation?: unknown; live?: boolean; storageId?: string };
	assert.equal(status.live, false);
	assert.equal(status.storageId, f.metadata.storageId);
	assert.ok(status.conversation);
	const snapshot = await observeColdStorage(f.metadata, "snapshot", { sessionId }) as { conversationId?: unknown };
	assert.ok(snapshot);
	await closeColdObservations();
});
