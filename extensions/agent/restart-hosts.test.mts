import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { agentRestartHosts, AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { createTestRuntime } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";

interface ManagerState {
	sessions: Map<string, AgentWorkerSession>;
	opening: Map<string, unknown>;
	controls: Map<string, Set<unknown>>;
	transfers: Map<string, unknown>;
	creations: Set<unknown>;
	associationFailures: Map<string, Error>;
	associationChanges: Map<string, unknown[]>;
	primary: Map<string, { pending: Map<string, unknown>; saveFailed?: boolean; historyUncertain?: boolean }>;
	closing: boolean;
}
function state(manager: AgentManager): ManagerState { return manager as unknown as ManagerState; }
function worker(): AgentWorkerSession {
	return Object.assign(Object.create(AgentWorkerSession.prototype), { tasks: new Set(), runtime: { session: { isIdle: true, isBashRunning: false, pendingMessageCount: 0 } } });
}
function fields(worker: AgentWorkerSession): Record<string, unknown> { return worker as unknown as Record<string, unknown>; }
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agent-restart-hosts-"));
	const runtime = await createTestRuntime({ modelsStorePath: join(root, "models.json") });
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const manager = new AgentManager(store, runtime, new ProjectTrustStore(root), undefined, root);
	return { root, manager, store, close: async () => {
		state(manager).sessions.clear(); state(manager).opening.clear(); state(manager).controls.clear(); state(manager).transfers.clear(); state(manager).creations.clear(); state(manager).closing = false;
		await manager.closeAll(); await store.close(); rmSync(root, { recursive: true, force: true });
	} };
}

test("restart sees busy nested hosts across all managers and retained primary owners", async () => {
	const parent = await fixture(), nested = await fixture();
	try {
		parent.manager.registerPrimary("parent", parent.root, () => {});
		parent.manager.suspendPrimary("parent");
		const child = worker(), grandchild = worker();
		state(parent.manager).sessions.set("child", child);
		state(nested.manager).sessions.set("grandchild", grandchild);
		assert.equal(agentRestartHosts().refusal, undefined);
		fields(grandchild).operation = "active";
		assert.match(agentRestartHosts().refusal ?? "", /active or queued work: grandchild/u);
		fields(grandchild).operation = undefined;
		assert.equal(agentRestartHosts().refusal, undefined);
		assert.notEqual(agentRestartHosts().identity, "");
	} finally { await nested.close(); await parent.close(); }
});

for (const [name, mutate] of [
	["operation", (w: AgentWorkerSession) => { fields(w).operation = "active"; }],
	["task", (w: AgentWorkerSession) => { fields(w).tasks = new Set([Promise.resolve()]); }],
	["control", (w: AgentWorkerSession) => { fields(w).controlTask = Promise.resolve(); }],
	["admission", (w: AgentWorkerSession) => { fields(w).preflight = true; }],
	["native admission", (w: AgentWorkerSession) => { fields(w).nativePreflights = 1; }],
	["native work", (w: AgentWorkerSession) => { fields(w).runtime = { session: { isIdle: false } }; }],
	["native bash", (w: AgentWorkerSession) => { fields(w).runtime = { session: { isIdle: true, isBashRunning: true } }; }],
	["queued input", (w: AgentWorkerSession) => { fields(w).runtime = { session: { isIdle: true, pendingMessageCount: 1 } }; }],
	["failed cleanup", (w: AgentWorkerSession) => { fields(w).cleanupFailed = true; }],
] as const) test(`restart refuses an agent host with ${name}`, async () => {
	const f = await fixture();
	try {
		const w = worker(); state(f.manager).sessions.set("child", w); mutate(w);
		assert.match(agentRestartHosts().refusal ?? "", /active or queued work: child/u);
	} finally { await f.close(); }
});

for (const [name, mutate] of [
	["open", (s: ManagerState) => { s.opening.set("child", Promise.resolve()); }],
	["host control", (s: ManagerState) => { s.controls.set("child", new Set([Promise.resolve()])); }],
	["ownership transfer", (s: ManagerState) => { s.transfers.set("child", Promise.resolve()); }],
	["creation", (s: ManagerState) => { s.creations.add(Promise.resolve()); }],
	["cleanup", (s: ManagerState) => { s.closing = true; }],
] as const) test(`restart refuses incomplete agent ${name}`, async () => {
	const f = await fixture();
	try { mutate(state(f.manager)); assert.match(agentRestartHosts().refusal ?? "", /Restart refused/u); }
	finally { await f.close(); }
});

for (const [name, mutate] of [
	["association failure", (s: ManagerState) => { s.associationFailures.set("child", new Error("private value")); }],
	["association change", (s: ManagerState) => { s.associationChanges.set("child", [{}]); }],
	["live-only result", (s: ManagerState) => { const w = worker(); fields(w).unsavedResult = { text: "private result" }; s.sessions.set("child", w); }],
	["pending delivery", (s: ManagerState) => { s.primary.set("child", { pending: new Map([["result", {}]]) }); }],
	["failed footer save", (s: ManagerState) => { s.primary.set("child", { pending: new Map(), saveFailed: true }); }],
	["uncertain footer history", (s: ManagerState) => { s.primary.set("child", { pending: new Map(), saveFailed: false, historyUncertain: true }); }],
] as const) test(`restart refuses unsaved agent ${name}`, async () => {
	const f = await fixture();
	try {
		mutate(state(f.manager)); assert.match(agentRestartHosts().refusal ?? "", /unsaved state: child/u);
		assert.doesNotMatch(agentRestartHosts().refusal ?? "", /private/u);
	} finally { state(f.manager).primary.clear(); await f.close(); }
});

test("restart retains a known footer save failure through a primary reload", async () => {
	const f = await fixture();
	try {
		f.manager.registerPrimary("parent", f.root, () => {});
		const primary = state(f.manager).primary.get("parent") as { pending: Map<string, unknown>; observe?: () => void };
		primary.observe = () => { throw new Error("save failed"); };
		f.manager.suspendPrimary("parent");
		assert.match(agentRestartHosts().refusal ?? "", /unsaved state: parent/u);
		f.manager.registerPrimary("parent", f.root, () => {});
		assert.match(agentRestartHosts().refusal ?? "", /unsaved state: parent/u);
	} finally { await f.close(); }
});

test("restart refuses an unfinished manager creation and an incompatible retained manager", () => {
	const owners = (globalThis as unknown as { [key: symbol]: { creating: Map<string, unknown>; managers: Map<string, unknown> } })[Symbol.for("pi.extension.agent.owners")];
	try {
		owners.creating.set("pending", Promise.resolve()); assert.match(agentRestartHosts().refusal ?? "", /creation is incomplete/u);
		owners.creating.delete("pending"); owners.managers.set("incompatible", {}); assert.match(agentRestartHosts().refusal ?? "", /another protocol/u);
	} finally { owners.creating.delete("pending"); owners.managers.delete("incompatible"); }
});

test("restart bounds and escapes agent IDs without inspecting detached run state", async (t) => {
	const f = await fixture();
	try {
		t.mock.method(f.store, "list", () => { throw new Error("store inspection forbidden"); });
		const runs = (f.manager as unknown as { detachedRuns: { list(): unknown[] } }).detachedRuns;
		t.mock.method(runs, "list", () => { throw new Error("detached inspection forbidden"); });
		assert.equal(agentRestartHosts().refusal, undefined);
		for (let i = 0; i < 12; i++) state(f.manager).opening.set(`${i}-\x1b${"x".repeat(200)}`, Promise.resolve());
		const refusal = agentRestartHosts().refusal ?? "";
		assert.match(refusal, /4 omitted/u); assert.doesNotMatch(refusal, /\x1b/u); assert.ok(refusal.length < 800);
	} finally { await f.close(); }
});
