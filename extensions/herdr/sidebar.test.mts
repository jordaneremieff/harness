import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearSubagentToken,
	formatCost,
	formatSubagentToken,
	parseSubagentActivity,
	registerSubagentSlot,
	reportSubagentToken,
	SUBAGENT_ACTIVITY_CHANNEL,
} from "./sidebar.ts";
import type { HerdrClient } from "./socket.ts";

interface Recorded {
	method: string;
	params: Record<string, unknown>;
}

function fakeClient(): { client: HerdrClient; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const client = {
		async send(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
		},
		async request() {
			throw new Error("unused");
		},
		nextSeq: (() => {
			let n = 0;
			return () => ++n;
		})(),
	};
	return { client: client as unknown as HerdrClient, calls };
}

describe("formatCost", () => {
	it("uses two decimals at one cent or more", () => {
		assert.equal(formatCost(0), "0.00");
		assert.equal(formatCost(0.01), "0.01");
		assert.equal(formatCost(37.5), "37.50");
	});
	it("uses four decimals under one cent", () => {
		assert.equal(formatCost(0.001), "0.0010");
		assert.equal(formatCost(0.0099), "0.0099");
	});
});

describe("formatSubagentToken", () => {
	it("joins the active count and spend with a middle dot", () => {
		assert.equal(formatSubagentToken(2, 0.37), "2 active · $0.37");
		assert.equal(formatSubagentToken(0, 0.37), "0 active · $0.37");
		assert.equal(formatSubagentToken(1, 0.005), "1 active · $0.0050");
	});
});

describe("parseSubagentActivity", () => {
	it("reads a well-formed payload", () => {
		assert.deepEqual(parseSubagentActivity({ active: 2, cost: 0.37 }), { active: 2, cost: 0.37 });
	});
	it("rejects a malformed payload", () => {
		assert.equal(parseSubagentActivity({ active: "2", cost: 0.37 }), undefined);
		assert.equal(parseSubagentActivity({ active: 2 }), undefined);
		assert.equal(parseSubagentActivity(null), undefined);
		assert.equal(parseSubagentActivity({ active: Infinity, cost: 0 }), undefined);
	});
	it("clamps negative values", () => {
		assert.deepEqual(parseSubagentActivity({ active: -1, cost: -2 }), { active: 0, cost: 0 });
	});
});

describe("subagent token reports", () => {
	it("reports the token with the formatted value and a bounded ttl", async () => {
		const { client, calls } = fakeClient();
		const value = await reportSubagentToken({ client, paneId: "w1:p1" }, { active: 2, cost: 0.37 });
		assert.equal(value, "2 active · $0.37");
		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.ok(report);
		assert.equal(report.params.pane_id, "w1:p1");
		assert.equal(report.params.source, "custom:pi-identity");
		assert.deepEqual(report.params.tokens, { subagents: "2 active · $0.37" });
		assert.equal(report.params.ttl_ms, 30 * 60 * 1000);
	});

	it("clears the token with a null value", async () => {
		const { client, calls } = fakeClient();
		await clearSubagentToken({ client, paneId: "w1:p1" });
		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.deepEqual(report?.params.tokens, { subagents: null });
	});

	it("shares the monotonic sequence with the identity source", async () => {
		const { client } = fakeClient();
		await reportSubagentToken({ client, paneId: "w1:p1" }, { active: 1, cost: 0.1 });
		await reportSubagentToken({ client, paneId: "w1:p1" }, { active: 0, cost: 0.1 });
		// nextSeq is shared on the client; two reports advance it twice.
		assert.equal(client.nextSeq(), 3);
	});
});

describe("registerSubagentSlot", () => {
	it("reports each activity event on the documented channel", async () => {
		const { client, calls } = fakeClient();
		const handlers = new Map<string, (data: unknown) => void>();
		const pi = {
			events: {
				on: (ch: string, h: (d: unknown) => void) => {
					handlers.set(ch, h);
					return () => handlers.delete(ch);
				},
			},
		} as never;
		const off = registerSubagentSlot(pi, { client, paneId: "w1:p1" });
		assert.ok(handlers.has(SUBAGENT_ACTIVITY_CHANNEL));
		handlers.get(SUBAGENT_ACTIVITY_CHANNEL)?.({ active: 3, cost: 1.2 });
		await new Promise((r) => setImmediate(r));
		const report = calls.find((c) => c.method === "pane.report_metadata");
		assert.deepEqual(report?.params.tokens, { subagents: "3 active · $1.20" });
		handlers.get(SUBAGENT_ACTIVITY_CHANNEL)?.({ active: 0, cost: 0 });
		await new Promise((r) => setImmediate(r));
		const cleared = calls.filter((c) => c.method === "pane.report_metadata").at(-1);
		assert.deepEqual(cleared?.params.tokens, { subagents: null });
		off();
		assert.equal(handlers.has(SUBAGENT_ACTIVITY_CHANNEL), false);
	});
});
