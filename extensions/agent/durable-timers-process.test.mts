/**
 * Production runner tests for scheduled inputs: SIGKILL before the deadline,
 * reopen, one admission at the original deadline, and survival of the host
 * across its idle window while a timer is pending.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { acquireHost, type HostConnection } from "./host-client.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import { killHost, runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";

interface TimerListPage {
	readonly timers: Array<{ timerId: number; status: string; deadline: number; firedAt: number | null; overdueMs: number | null }>;
}

/** Wait for the delivery receipt of one request ID, event-based. */
async function waitForRequestReceipt(host: HostConnection, ownerId: string, requestId: string, timeoutMs = 60000): Promise<DeliveryReceipt> {
	const signal = AbortSignal.timeout(timeoutMs);
	for (;;) {
		const page = (await host.request("receipts", { ownerId, wait: true }, { signal })) as { receipts: DeliveryReceipt[] };
		const found = page.receipts.find((receipt) => receipt.requestId === requestId);
		// A delivered receipt stays pending until its owner acknowledges it; ack every read so the next wait blocks.
		if (page.receipts.length > 0) await host.request("acknowledge", { ownerId, submissionIds: page.receipts.map((receipt) => receipt.submissionId) });
		if (found !== undefined) return found;
	}
}

/** Wait for one timer deadline so the test reopens the host after it. */
async function waitPastDeadline(deadline: number): Promise<void> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return;
	await new Promise<void>((resolve) => {
		setTimeout(resolve, remaining);
	});
}

it("fires a killed host's scheduled input once after reopen with the original deadline", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const deadline = Date.now() + 400;
	const first = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, first.pid);
	const scheduled = (await first.request("timer-schedule", {
		sessionId: f.metadata.storageId,
		message: "PROCESS_TIMER",
		deliverAt: deadline,
		mode: "followUp",
		origin: "operator",
		ownerId: f.ownerId,
		scheduleId: "process-timer",
		requestId: "process-timer-delivery",
	})) as { timerId: number; deadline: number };
	assert.equal(scheduled.deadline, deadline);
	killHost(first.pid);
	await first.close();

	const second = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForRequestReceipt(second, f.ownerId, "process-timer-delivery");
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const page = (await second.request("timer-list", { sessionId: f.metadata.storageId })) as TimerListPage;
		const row = page.timers.find((timer) => timer.timerId === scheduled.timerId);
		assert.ok(row, "the recovered timer keeps its record");
		assert.equal(row.status, "fired");
		assert.equal(row.deadline, deadline, "the deadline survives the kill unchanged");
		assert.ok(row.firedAt !== null && row.firedAt >= deadline);
		const search = (await second.request("inspect", { view: "search", query: "PROCESS_TIMER" })) as { matches: unknown[] };
		assert.equal(search.matches.length, 1, "the recovered timer admits one input");
	} finally {
		await second.close().catch(() => undefined);
	}
});

it("keeps the host process through its idle window while a timer is pending", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	// A six-second idle window: the first retirement check falls between the
	// disconnect and the deadline, and the reconnect lands before the next one.
	const env = { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "0.1" };
	const first = await acquireHost(f.metadata, { env });
	trackHost(t, first.pid);
	const pid = first.pid;
	const deadline = Date.now() + 8000;
	await first.request("timer-schedule", {
		sessionId: f.metadata.storageId,
		message: "IDLE_WINDOW_TIMER",
		deliverAt: deadline,
		mode: "followUp",
		origin: "operator",
		ownerId: f.ownerId,
		scheduleId: "idle-window-timer",
		requestId: "idle-window-timer-delivery",
	});
	await first.close();
	// Reconnecting after the deadline must reach the same process; a host that
	// ignored the pending timer would retire at its first idle check and a
	// reconnect would relaunch it with a new PID.
	await waitPastDeadline(deadline + 300);
	const second = await acquireHost(f.metadata, { env });
	trackHost(t, second.pid);
	try {
		assert.equal(second.pid, pid, "the host did not idle-retire with a pending timer");
		const receipt = await waitForRequestReceipt(second, f.ownerId, "idle-window-timer-delivery", 30000);
		assert.equal(receipt.status, "done");
	} finally {
		await second.close().catch(() => undefined);
	}
});
