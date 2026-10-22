/**
 * Host-process timer tests with native storage, controlled deadlines, and
 * explicit idle checks. Process loss occurs before the clock passes the deadline.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireHost, connectHost, type HostConnection } from "./host-client.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import { killHost, runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { fixtureMetadata } from "./host-fixture.mts";
import { runHost } from "./host-process.ts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";

interface TimerListPage {
	readonly timers: Array<{ timerId: number; status: string; deadline: number; firedAt: number | null; overdueMs: number | null }>;
}

async function waitForRequestReceipt(host: HostConnection, ownerId: string, requestId: string, timeoutMs = 60000): Promise<DeliveryReceipt> {
	const signal = AbortSignal.timeout(timeoutMs);
	for (;;) {
		const page = (await host.request("receipts", { ownerId, wait: true }, { signal })) as { receipts: DeliveryReceipt[] };
		const found = page.receipts.find((receipt) => receipt.requestId === requestId);
		if (page.receipts.length > 0) await host.request("acknowledge", { ownerId, submissionIds: page.receipts.map((receipt) => receipt.submissionId) });
		if (found !== undefined) return found;
	}
}

it("fires a killed host's scheduled input once after reopen with the original deadline", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const deadline = 2000;
	const runner = fileURLToPath(new URL("./durable-schedule-fixture.mts", import.meta.url));
	const first = await acquireHost(f.metadata, { runner, env: { DURABLE_TEST_NOW: "1000" }, retryAttempts: 0 });
	trackHost(t, first.pid);
	assert.deepEqual(await first.request("command", { name: "fixture-clock" }), { now: 1000 });
	const scheduled = (await first.request("timer-schedule", {
		sessionId: f.metadata.storageId, message: "PROCESS_TIMER", deliverAt: deadline,
		mode: "followUp", origin: "operator", ownerId: f.ownerId,
		scheduleId: "process-timer", requestId: "process-timer-delivery",
	})) as { timerId: number; deadline: number };
	const before = (await first.request("inspect", { view: "search", query: "PROCESS_TIMER" })) as { matches: unknown[] };
	assert.equal(before.matches.length, 0, "the scheduler gate keeps the input unadmitted before the kill");
	const closed = new Promise<void>((resolve) => first.onClose(resolve));
	killHost(first.pid);
	await closed;
	await first.close();
	// Only the replacement sees the clock beyond the retained deadline.
	const second = await acquireHost(f.metadata, { runner, env: { DURABLE_TEST_NOW: "4000" } });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid);
		assert.deepEqual(await second.request("command", { name: "fixture-clock" }), { now: 4000 });
		await second.request("command", { name: "fixture-resume" });
		const receipt = await waitForRequestReceipt(second, f.ownerId, "process-timer-delivery");
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /schedule fixture answer/u);
		const page = (await second.request("timer-list", { sessionId: f.metadata.storageId })) as TimerListPage;
		const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
		assert.ok(row);
		assert.equal(row.status, "fired");
		assert.equal(row.deadline, deadline);
		assert.equal(row.firedAt, 4000);
		assert.equal(row.overdueMs, 2000);
		const search = (await second.request("inspect", { view: "search", query: "PROCESS_TIMER" })) as { matches: unknown[] };
		assert.equal(search.matches.length, 1, "recovery admits one input");
	} finally { await second.close(); }
});

it("reattaches one sleeping check-in deadline after process loss and stops it at settlement", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const runner = fileURLToPath(new URL("./durable-schedule-fixture.mts", import.meta.url));
	const first = await acquireHost(f.metadata, { runner, env: { DURABLE_TEST_NOW: "1000", DURABLE_TEST_HOLD_ANSWER: "1" }, retryAttempts: 0 });
	trackHost(t, first.pid);
	await first.request("submit", { sessionId: f.metadata.storageId, message: "PROCESS_CHECK_IN", requestId: "process-check-in", ownerId: f.ownerId, origin: "model", checkInMinutes: 1 });
	await first.request("command", { name: "fixture-resume" });
	await first.request("command", { name: "fixture-checkin-ready" }, { signal: AbortSignal.timeout(15000) });
	const closed = new Promise<void>((resolve) => first.onClose(resolve));
	killHost(first.pid);
	await closed;
	await first.close();
	const second = await acquireHost(f.metadata, { runner, env: { DURABLE_TEST_NOW: "61000", DURABLE_TEST_HOLD_ANSWER: "1" } });
	trackHost(t, second.pid);
	try {
		await second.request("command", { name: "fixture-resume" });
		await second.request("command", { name: "fixture-checkin-ready" }, { signal: AbortSignal.timeout(15000) });
		const deliveries = await second.request("receipts", { ownerId: f.ownerId, wait: true }) as { reports: Array<{ sourceId: string; ownerId: string }> };
		assert.equal(deliveries.reports.length, 1);
		assert.equal(deliveries.reports[0].ownerId, f.ownerId);
		assert.match(deliveries.reports[0].sourceId, /:process-check-in:1$/u);
		const before = await second.request("status", { sessionId: f.metadata.storageId }) as { conversation: { tasks: Array<{ kind: string }> } };
		assert.equal(before.conversation.tasks.filter((task) => task.kind === "agent.check-in").length, 1);
		assert.equal(before.conversation.tasks.filter((task) => task.kind === "agent.check-in-deadline").length, 1);
		await second.request("command", { name: "fixture-release-answer" });
		assert.equal((await waitForRequestReceipt(second, f.ownerId, "process-check-in")).status, "done");
		const after = await second.request("status", { sessionId: f.metadata.storageId }) as { conversation: { tasks: Array<{ kind: string }> } };
		assert.equal(after.conversation.tasks.some((task) => task.kind.startsWith("agent.check-in")), false);
		const final = await second.request("receipts", { ownerId: f.ownerId }) as { reports: unknown[] };
		assert.deepEqual(final.reports, []);
	} finally { await second.close(); }
});

it("keeps the host process through its idle window while a timer is pending", { timeout: 60000 }, async (t) => {
	let now = Date.now();
	const f = await scheduleFixture(t, { agentExtension: true, now: () => now, resume: false });
	const metadata = { ...fixtureMetadata(f.root, f.storageId), cwd: join(f.root, "work"), storagePath: f.storagePath };
	let check: (() => void) | undefined;
	let scheduled: (() => void) | undefined;
	let idleChecks = 0;
	const host = await runHost(() => ({
		request: (method, params) => f.host.request(method, params as Record<string, unknown> | undefined),
		close: () => f.close(),
		isIdle: () => { idleChecks += 1; return f.host.isIdle(); },
	}), {
		metadata, idleMs: 3000, announceReady() {},
		scheduleIdleCheck: (callback) => {
			check = callback;
			scheduled?.();
			return () => { if (check === callback) check = undefined; };
		},
	});
	t.after(() => host.close());
	async function fireIdleCheck(): Promise<void> {
		if (check === undefined) await new Promise<void>((resolve) => { scheduled = resolve; });
		scheduled = undefined;
		const callback = check;
		assert.ok(callback);
		check = undefined;
		callback();
	}
	const first = await connectHost(metadata);
	const pid = first.pid;
	const deadline = now + 8000;
	await first.request("timer-schedule", {
		sessionId: f.storageId, message: "IDLE_WINDOW_TIMER", deliverAt: deadline,
		mode: "followUp", origin: "operator", ownerId: f.ownerId,
		scheduleId: "idle-window-timer", requestId: "idle-window-timer-delivery",
	});
	assert.equal(await f.host.refreshIdle(), false);
	await first.close();
	await fireIdleCheck();
	await fireIdleCheck();
	assert.equal(idleChecks, 2, "two disconnected idle checks reached the runtime before the deadline");
	const second = await connectHost(metadata);
	t.after(() => second.close());
	assert.equal(second.pid, pid);
	now = deadline + 1;
	f.host.harness.resume();
	assert.equal((await f.waitForReceipt("idle-window-timer-delivery")).status, "done");
	assert.equal(await f.host.refreshIdle(), true);
	await second.close();
	await fireIdleCheck();
	await host.done;
	assert.equal(idleChecks, 3, "settled work permits the next idle check to retire the same host");
});
