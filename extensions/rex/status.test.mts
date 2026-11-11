import assert from "node:assert/strict";
import test from "node:test";
import { rexStatus, type HostActivity, type RexExecutor, type StatusBinding, type StatusStore } from "./status.ts";
import { createRexBudget } from "./deadline.ts";
import type { ResolvedTarget, RexRequest } from "./core.ts";

const target: ResolvedTarget = { source: "explicit", server: { endpoint: "unix:///synthetic-rex", hostId: "host", instanceId: "instance", selection: "test" }, sessionId: "session:00000000-0000-0000-0000-000000000001", blockId: "block:00000000-0000-0000-0000-000000000002" };
const call = { ownerId: "storage:1", callId: "status-call", cwd: "/test" };
const activity = async (): Promise<HostActivity> => ({ host: "durable", state: "active", source: "public test host", observedAt: new Date().toISOString(), note: "Current live task only." });
function fixture() {
	let binding: StatusBinding | undefined;
	const requests: RexRequest[] = [];
	let currentTarget = target;
	const core: RexExecutor = { dispose: () => {}, execute: async (request) => { requests.push(request); return { ok: true, outcome: "snapshot", target: currentTarget, data: { records: [{ state: "blocked", kind: "permission", msg: "Untrusted report" }] }, effects: { state: "none" }, coverage: { bounded: true } }; } };
	const store: StatusStore = { read: async () => binding, write: async (next) => { binding = next; } };
	return { core, store, requests, binding: () => binding, replace: (next: ResolvedTarget) => { currentTarget = next; } };
}

test("status binding requires explicit verified IDs and never sends terminal input", async () => {
	const f = fixture();
	const inherited = await rexStatus({ op: "bind", target: { source: "inherited" } }, call, f.core, f.store, activity);
	assert.equal(inherited.ok, false);
	assert.equal(f.requests.length, 0);
	const bound = await rexStatus({ op: "bind", target: { server: target.server.endpoint, session: target.sessionId, block: target.blockId } }, call, f.core, f.store, activity);
	assert.equal(bound.ok, true);
	assert.equal(f.binding()?.ownerId, call.ownerId);
	const snapshot = await rexStatus({ op: "snapshot" }, call, f.core, f.store, activity);
	assert.equal(snapshot.ok, true);
	assert.match(JSON.stringify(snapshot.data), /no terminal-output or status setter/);
	assert.equal((snapshot.data as { hostActivity: HostActivity }).hostActivity.state, "active");
	assert.ok(f.requests.every((request) => request.op === "resolve" || request.op === "inspect"));
	await rexStatus({ op: "unbind" }, call, f.core, f.store, activity);
	assert.equal(f.binding(), undefined);
});

test("status resolution and verification share one budget before binding admission", async () => {
	for (const delay of [400, 600]) {
		const f = fixture();
		let now = 0;
		const budget = createRexBudget(1000, 300000, undefined, { now: () => now, schedule: () => () => {} });
		const remaining: number[] = [];
		const core: RexExecutor = { dispose: () => {}, execute: async (_request, context) => {
			assert.equal(context.budget, budget);
			remaining.push(budget.remaining("work"));
			now += delay;
			return { ok: true, outcome: "snapshot", target, effects: { state: "none" }, coverage: { bounded: true } };
		} };
		try {
			const response = await rexStatus({ op: "bind", target: { server: target.server.endpoint, session: target.sessionId, block: target.blockId } }, { ...call, budget, signal: budget.signal }, core, f.store, activity);
			assert.deepEqual(remaining, [900, 900 - delay]);
			assert.equal(response.outcome, delay === 400 ? "status_bound" : "timeout");
			assert.equal(f.binding() !== undefined, delay === 400);
		} finally { budget.dispose(); }
	}
});

test("status binding and snapshot preserve omitted-data coverage and source notes", async () => {
	const f = fixture();
	const partial: RexExecutor = {
		dispose: () => {},
		execute: async () => ({ ok: true, outcome: "snapshot", target, data: { omitted: true }, effects: { state: "none" }, coverage: { bounded: true, truncated: true, dataOmitted: true, note: "Native status bulk data was omitted." } }),
	};
	const bound = await rexStatus({ op: "bind", target: { server: target.server.endpoint, session: target.sessionId, block: target.blockId } }, call, partial, f.store, activity);
	const snapshot = await rexStatus({ op: "snapshot" }, call, partial, f.store, activity);
	for (const result of [bound, snapshot]) {
		assert.equal(result.ok, true);
		assert.equal(result.coverage.truncated, true);
		assert.equal(result.coverage.dataOmitted, true);
		assert.match(result.coverage.note ?? "", /Native status bulk data was omitted/);
		assert.match(result.coverage.note ?? "", /not permission, ownership or task acceptance/);
	}
});

test("status inspection refuses a replaced server and foreign caller binding", async () => {
	const f = fixture();
	await rexStatus({ op: "bind", target: { server: target.server.endpoint, session: target.sessionId, block: target.blockId } }, call, f.core, f.store, activity);
	f.replace({ ...target, server: { ...target.server, instanceId: "replacement" } });
	const changed = await rexStatus({ op: "snapshot" }, call, f.core, f.store, activity);
	assert.equal(changed.outcome, "stale_status_binding");
	const foreign = await rexStatus({ op: "snapshot" }, { ...call, ownerId: "storage:2" }, f.core, f.store, activity);
	assert.equal(foreign.ok, false);
	assert.match(foreign.error ?? "", /another caller/);
});
