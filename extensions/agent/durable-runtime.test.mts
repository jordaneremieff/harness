/**
 * Production durable-runtime SIGKILL tests.
 *
 * Each test launches the real `durable-runner.ts` through `acquireHost` with a
 * fixture agent home whose settings load the faux provider and unsafe effect
 * tool from `testdata/durable-runtime`. The test kills the host process at a
 * durable checkpoint, relaunches through `acquireHost`, and checks resumption,
 * deduplication, the single unsafe effect, the retained result, and owner
 * delivery acknowledgement.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import type { CatalogView } from "./catalog-view.ts";
import { acquireHost } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { observeDurableStorage } from "./durable-runtime.ts";
import { childCatalogRecord, killHost, runtimeFixture, trackHost, waitForFile, waitForReceipt } from "./durable-runtime-fixture.mts";

interface SubmitResult {
	readonly submissionId: string | number;
	readonly deduped: boolean;
}

interface HistoryPage {
	readonly entries: readonly unknown[];
}

interface ReceiptsPage {
	readonly receipts: readonly unknown[];
}

interface AcknowledgeResult {
	readonly acknowledged: readonly unknown[];
}

interface SearchPage {
	readonly matches: readonly unknown[];
}

/** Reject when `ready` does not settle before the public deadline signal fires. */
async function within(ready: Promise<void>, timeoutMs: number, message: string): Promise<void> {
	const deadline = AbortSignal.timeout(timeoutMs);
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new Error(message));
		deadline.addEventListener("abort", onAbort, { once: true });
		ready.then(
			() => {
				deadline.removeEventListener("abort", onAbort);
				resolve();
			},
			(error) => {
				deadline.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

it("reads a cold observation without bootstrapping contributions", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "OBSERVE_ME", requestId: "observe-owner", ownerId: f.ownerId }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
	} finally {
		await primary.close().catch(() => {});
	}
	const marker = join(f.testDir, "observation-create.txt");
	process.env.DURABLE_TEST_CREATE_MARKER = marker;
	try {
		const observed = await observeDurableStorage(f.metadata, "status", { sessionId: f.metadata.storageId }) as { live: boolean; storageId: string; conversation?: unknown };
		assert.equal(observed.live, false);
		assert.equal(observed.storageId, f.metadata.storageId);
		assert.ok(observed.conversation, "the cold status carries the retained conversation");
	} finally {
		delete process.env.DURABLE_TEST_CREATE_MARKER;
	}
	assert.equal(existsSync(marker), false, "the cold read ran no contribution create");
});

it("spawns a cross-cwd child in an independent storage and delivers its result to the owner conversation", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("spawn") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "SPAWN_CHILD: start the child and report back", requestId: "spawn-owner" }) as SubmitResult;
		assert.equal(submitted.deduped, false);
		await waitForFile(join(f.testDir, "delivered"));
		const record = await childCatalogRecord(f);
		assert.notEqual(record.storageId, f.metadata.storageId, "the child lives in an independent storage");
		assert.equal(record.cwd, realpathSync(f.childCwd), "the child uses the requested working directory");
		const child = await acquireHost(hostMetadata(record));
		trackHost(t, child.pid);
		try {
			assert.notEqual(child.pid, primary.pid, "the child runs in its own host process");
			const found = await primary.request("inspect", { view: "search", query: "Agent result from", source: "user" }) as { matches: Array<{ excerpt: string }> };
			assert.equal(found.matches.length, 1, JSON.stringify(found));
			const excerpt = found.matches[0]?.excerpt ?? "";
			assert.match(excerpt, /CHILD_RESULT/u);
			const submission = /\(submission (\d+)\)/u.exec(excerpt)?.[1];
			assert.ok(submission, excerpt);
			const deliveryRequest = `deliver:${record.storageId}:submission:${submission}`;
			const repeat = await primary.request("submit", { message: "DUPLICATE_DELIVERY", requestId: deliveryRequest }) as SubmitResult;
			assert.equal(repeat.deduped, true, "the delivery request ID is retained and deduplicated");
			const after = await primary.request("inspect", { view: "search", query: "DUPLICATE_DELIVERY" }) as { matches: unknown[] };
			assert.equal(after.matches.length, 0, "the deduplicated submit wrote no new entry");
		} finally {
			await child.close().catch(() => {});
		}
	} finally {
		await primary.close().catch(() => {});
	}
});

it("resumes an outstanding model request after SIGKILL without a duplicate submission", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const first = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await waitForFile(join(f.testDir, "requested"));
	killHost(first.pid);
	await first.close();

	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const repeat = await second.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId, "the same request ID reuses the retained submission");
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		const history = await second.request("inspect", { view: "history", source: "user", limit: 10 }) as HistoryPage;
		assert.equal(history.entries.length, 1, "recovery leaves one user entry");
		const acknowledged = await second.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] }) as AcknowledgeResult;
		assert.equal(acknowledged.acknowledged.length, 1, "the owner acknowledges the receipt once");
		const after = await second.request("receipts", { ownerId: f.ownerId }) as ReceiptsPage;
		assert.equal(after.receipts.length, 0, "an acknowledged receipt is not delivered again");
	} finally {
		await second.close();
	}
});

it("preserves a crash recovery marker through primary startup and clears it after idle retirement", { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(f.root);
	const ownerId = randomUUID();
	const first = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	let submitted: SubmitResult;
	try {
		submitted = await first.request("submit", { message: "recover the marked work", requestId: "marked-crash", ownerId }) as SubmitResult;
		await waitForFile(join(f.testDir, "requested"));
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
		killHost(first.pid);
		await waitForExit(first.pid);
	} finally { await first.close(); }
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "SIGKILL leaves the due marker on disk");

	const acquired: string[] = [];
	let recoveredPid = 0;
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata) => {
			acquired.push(metadata.storageId);
			const connection = await acquireHost(metadata, { env: f.env("answer") });
			recoveredPid = connection.pid;
			trackHost(t, connection.pid);
			return connection;
		},
	});
	const controller = new AbortController();
	let receipt: Record<string, unknown> | undefined;
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	try {
		await manager.registerPrimary(ownerId, {
			cwd: f.cwd, signal: controller.signal,
			send: (_text, details) => {
				const value = details as Record<string, unknown>;
				if (value.storageId !== f.metadata.storageId || String(value.submissionId) !== String(submitted.submissionId)) return;
				receipt = value;
				resolveDelivered();
			},
		});
		assert.deepEqual(acquired, [f.metadata.storageId], "primary startup recovers the marked storage");
		assert.notEqual(recoveredPid, first.pid);
		await within(delivered, 10000, "the recovered submission did not reach its primary");
		assert.equal(receipt?.status, "done");
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		await waitForExit(recoveredPid);
		assert.equal(controller.signal.aborted, false, "the primary remains registered through host retirement");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "completion, delivery acknowledgement, and clean idle retirement clear the marker");
	} finally {
		controller.abort();
		manager.close();
	}
});

it("relaunches a connected host after SIGKILL while its primary stays alive", { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t);
	const ownerId = randomUUID();
	const controller = new AbortController();
	const pids: number[] = [];
	let resolveRecovered: () => void = () => {};
	const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata, options) => {
			assert.equal(options?.retryAttempts, 0, "the manager owns every automatic relaunch");
			const client = await acquireHost(metadata, { ...options, env: f.env(pids.length === 0 ? "request" : "answer") });
			pids.push(client.pid);
			if (pids.length === 2) resolveRecovered();
			trackHost(t, client.pid);
			return client;
		},
	});
	let receipt: Record<string, unknown> | undefined;
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	try {
		await manager.registerPrimary(ownerId, {
			cwd: f.cwd, signal: controller.signal,
			send: (_text, details) => { receipt = details as Record<string, unknown>; resolveDelivered(); },
		});
		const submitted = await manager.control("submit", { sessionId: f.metadata.storageId, message: "recover without restarting the primary", requestId: "connected-crash" }, { id: ownerId, cwd: f.cwd }) as SubmitResult;
		await waitForFile(join(f.testDir, "requested"));
		assert.equal(manager.catalog.read(f.metadata.storageId).recoveryDue, true);
		killHost(pids[0] as number);
		await within(delivered, 15000, "the live primary received no recovered result").catch(async (error) => { throw new Error(`${String(error)}; pids=${JSON.stringify(pids)}; status=${JSON.stringify(await manager.status())}`); });
		await within(recovered, 10000, "the replacement connection did not become ready");
		assert.equal(controller.signal.aborted, false);
		assert.equal(pids.length, 2, "channel loss automatically launches one replacement");
		assert.notEqual(pids[1], pids[0]);
		assert.equal(receipt?.status, "done");
		assert.equal(String(receipt?.submissionId), String(submitted.submissionId));
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		const history = await manager.control("inspect", { sessionId: f.metadata.storageId, view: "history", source: "user", limit: 10 }, { id: ownerId, cwd: f.cwd }) as HistoryPage;
		assert.equal(history.entries.length, 1, "relaunch resumes the retained submission without another input");
	} finally { controller.abort(); manager.close(); }
});

it("does not rerun an unsafe effect after SIGKILL and delivers the retained result once", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const first = await acquireHost(f.metadata, { env: f.env("effect") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await waitForFile(join(f.testDir, "effect"));
	killHost(first.pid);
	await first.close();

	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const effects = () => readFileSync(join(f.testDir, "effect.txt"), "utf8").trim().split("\n").filter((line) => line !== "").length;
		assert.equal(effects(), 1, "the unsafe effect ran once before the kill");
		const repeat = await second.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId);
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		assert.equal(effects(), 1, "the resumed and deduplicated request reran no effect");
		const interrupted = await second.request("inspect", { view: "search", query: "interrupted" }) as SearchPage;
		assert.ok(interrupted.matches.length >= 1, "the interrupted tool result is retained");
	} finally {
		await second.close();
	}
});

/** Wait until a host process exits, bounded. */
async function waitForExit(pid: number, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try { process.kill(pid, 0); } catch { return; }
		if (Date.now() >= deadline) throw new Error("host did not exit before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Wait for the coalesced catalog view publication, bounded. */
async function readViewWhenPublished(catalog: AgentCatalog, storageId: string, timeoutMs = 10000): Promise<CatalogView | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const view = catalog.read(storageId).view;
		if (view !== undefined) return view;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

it("marks recovery due before admission and reports the recovery state", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, primary.pid);
	try {
		assert.deepEqual(await primary.request("recovery-state", {}), { workPending: false, deliveriesPending: false });
		const submitted = await primary.request("submit", { message: "RECOVERY_MARK", requestId: "recovery-mark" }) as SubmitResult;
		assert.ok(submitted.submissionId);
		await waitForFile(join(f.testDir, "requested"));
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "admission marks the record before the request completes");
		const busy = await primary.request("recovery-state", {}) as { workPending: boolean; deliveriesPending: boolean };
		assert.equal(busy.workPending, true);
		const view = await readViewWhenPublished(catalog, f.metadata.storageId);
		assert.ok(view, "the gated host published a catalog view");
		assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the live view carries this storage's row");
	} finally {
		await primary.close().catch(() => {});
	}
});

it("publishes a bounded catalog view and clears recovery due on a clean close", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	const pid = primary.pid;
	try {
		const submitted = await primary.request("submit", { message: "VIEW_SOURCE", requestId: "view-source", ownerId: f.ownerId }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "the admitted request marked recovery due");
		await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
	} finally {
		await primary.close().catch(() => {});
	}
	// SIGTERM inside the coalescing window: the clean close must flush the last view.
	process.kill(pid, "SIGTERM");
	await waitForExit(pid);
	const view = await readViewWhenPublished(catalog, f.metadata.storageId);
	assert.ok(view, "the clean close flushed the final catalog view");
	assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the view carries this storage's rows");
	assert.equal(view.coverage.complete, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "a clean idle close clears the marker");
});

it("keeps change notifications after reload replaces the durable host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	let unsubscribe: (() => void) | undefined;
	try {
		let notifications = 0;
		let reloaded = false;
		let resolveVerified: () => void = () => {};
		let rejectGuard: (error: unknown) => void = () => {};
		const verified = new Promise<void>((resolve) => {
			resolveVerified = resolve;
		});
		const failed = new Promise<void>((_resolve, reject) => {
			rejectGuard = reject;
		});
		let checking = false;
		let checkAgain = false;
		/** One guarded async check per change event: reload while idle, then verify the configured name. */
		const advance = async (): Promise<void> => {
			const status = (await primary.request("status", { sessionId: f.metadata.storageId })) as { conversation?: { name?: string } };
			if (status.conversation?.name === "after reload") {
				resolveVerified();
				return;
			}
			if (reloaded) return;
			const outcome = (await primary.request("command", { name: "reload", invocationId: "reload-changes" })) as { reloaded?: boolean };
			if (outcome.reloaded !== true) return;
			reloaded = true;
			await primary.request("configure", { sessionId: f.metadata.storageId, name: "after reload" });
		};
		const runGuard = (): void => {
			if (checking) {
				checkAgain = true;
				return;
			}
			checking = true;
			void (async () => {
				try {
					for (;;) {
						await advance();
						if (!checkAgain) return;
						checkAgain = false;
					}
				} catch (error) {
					rejectGuard(error);
				} finally {
					checking = false;
				}
			})();
		};
		const subscribeChanges = primary.subscribeChanges?.bind(primary);
		assert.ok(subscribeChanges, "the acquired connection exposes change subscriptions");
		unsubscribe = await subscribeChanges(() => {
			notifications += 1;
			runGuard();
		});
		await Promise.race([within(verified, 30000, "no change notification carried the configured name after reload"), failed]);
		assert.equal(reloaded, true, "the reload completed after the guarded idle check");
		assert.ok(notifications >= 2, "the initial snapshot and a post-reload commit notified the persistent listener");
	} finally {
		unsubscribe?.();
		await primary.close().catch(() => {});
	}
});

it("repairs an unavailable retained model through attach on an idle host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	// The runner reads the passed metadata; the on-disk catalog record is not consulted for the open.
	const unavailable = { provider: "absent", modelId: "missing-model" };
	const metadata = { ...f.metadata, model: unavailable };
	const primary = await acquireHost(metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const before = (await primary.request("status", { sessionId: metadata.storageId })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(before.conversation?.agent?.model, unavailable, "the retained unavailable identity is reported before repair");
		const repaired = (await primary.request("attach", { sessionId: metadata.storageId, model: { provider: "durable-runtime-fixture", modelId: "fixture-model" } })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(repaired.conversation?.agent?.model, { provider: "durable-runtime-fixture", modelId: "fixture-model" }, "attach repairs the stored identity with the fixture model");
	} finally {
		await primary.close().catch(() => {});
	}
});
