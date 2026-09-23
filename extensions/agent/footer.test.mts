import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { formatAgentFooter, NestedStatus, OwnedSpend, WORK_STATUS_REQUEST, WORK_STATUS_SNAPSHOT } from "./footer.ts";
import { fixture } from "./native-fixture.mts";

const usage = (cost: number): Usage => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const message = (cost: number): AssistantMessage => ({ role: "assistant", api: "openai-completions", provider: "test", model: "test", content: [], usage: usage(cost), stopReason: "stop", timestamp: Date.now() });

test("owned spend excludes imported history and counts native usage categories once across replacement", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message(10));
	const spend = new OwnedSpend(); spend.bind(manager);
	manager.appendMessage(message(1));
	manager.appendUsage("cache_warm", "test", "test", usage(2));
	manager.appendMessage({ role: "toolResult", toolCallId: "tool", toolName: "nested", content: [], isError: false, timestamp: Date.now(), usage: usage(3) });
	manager.appendCompaction("summary", manager.getLeafId() ?? "", 10, undefined, false, usage(4));
	spend.sync(); spend.sync(); spend.bind(manager);
	assert.deepEqual(spend.total, { cost: 10, incomplete: false });
	const replacement = SessionManager.inMemory(); replacement.appendMessage(message(50));
	spend.bind(replacement); replacement.appendMessage(message(0.0001)); spend.sync();
	assert.equal(spend.total.cost, 10.0001);
	replacement.appendMessage(message(Number.NaN)); spend.sync();
	assert.equal(spend.total.incomplete, true);
	assert.equal(spend.total.cost, 10.0001);
});

test("nested snapshots replace totals, baseline inherited spend, reject invalid values, and retain unknown on loss", () => {
	const bus = createEventBus(); const nested = new NestedStatus(); let updates = 0;
	nested.bind(bus, "one", () => updates++);
	bus.on(WORK_STATUS_REQUEST, () => bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "one", available: true, active: 0, cost: 10, incomplete: false }));
	nested.request(bus);
	const send = (cost: number, active = 1) => bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "one", available: true, active, cost, incomplete: false });
	send(12); send(12);
	assert.deepEqual(nested.snapshot(), { active: 1, cost: 2, incomplete: false, available: true });
	nested.bind(bus, "one", () => updates++); send(13);
	assert.equal(nested.snapshot().cost, 3, "same-session reload retains its baseline");
	send(-1);
	assert.equal(nested.snapshot().available, false);
	send(13, 0);
	bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "one", available: false });
	assert.equal(nested.snapshot().cost, 3);
	assert.equal(nested.snapshot().available, false);
	nested.bind(bus, "two", () => updates++);
	assert.equal(nested.snapshot().cost, 3);
	assert.equal(nested.snapshot().incomplete, true);
	const before = updates; nested.close(); send(90);
	assert.equal(updates, before);
});

test("late first snapshots expose unanchored spend instead of subtracting already completed work", () => {
	const bus = createEventBus(); const nested = new NestedStatus();
	nested.bind(bus, "late", () => {}); nested.request(bus);
	bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "late", available: true, active: 1, cost: 5, incomplete: false });
	assert.deepEqual(nested.snapshot(), { active: 1, cost: 0, incomplete: true, available: true });
	nested.request(bus);
	bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "late", available: true, active: 0, cost: 9, incomplete: false });
	assert.equal(nested.snapshot().incomplete, true);
	assert.equal(nested.snapshot().cost, 4);
	nested.bind(bus, "late", () => {}); nested.request(bus);
	bus.emit(WORK_STATUS_SNAPSHOT, { version: 1, publisher: "subagent", sessionId: "late", available: true, active: 0, cost: 9, incomplete: false });
	assert.equal(nested.snapshot().cost, 4);
	assert.equal(nested.snapshot().incomplete, true);
	nested.close();
});

test("footer distinguishes active, observed zero, missing nested evidence, and detached records", () => {
	const detached = { exists: false, recorded: 0, unavailable: 0 };
	assert.equal(formatAgentFooter([], detached), undefined);
	const state = { active: true, spend: { cost: 0.0001, incomplete: false }, nested: { active: 0, cost: 0, available: false, incomplete: false } };
	assert.equal(formatAgentFooter([state], detached), "agents: 1 active · $0.0001 local · subs 0+?/$0.00+?");
	assert.match(formatAgentFooter([{ ...state, active: false }], { exists: true, recorded: 2, unavailable: 1 }) ?? "", /agents: 0 active.*detached 2 recorded\/1 lost\/\$\?/u);
});

test("ordinary host receives package snapshots through its real headless extension bus and preserves native spend on reload", async () => {
	const source = `export default function(pi) {
		let ctx;
		const publish = (cost) => pi.events.emit("harness:work-status:snapshot", { version: 1, publisher: "subagent", sessionId: ctx.sessionManager.getSessionId(), available: true, active: 1, cost, incomplete: false });
		pi.on("session_start", (_event, current) => { ctx = current; publish(5); });
		pi.events.on("harness:work-status:request", () => publish(5));
		pi.on("agent_start", () => publish(7));
		pi.registerCommand("fresh", { handler: async (_args, ctx) => { await ctx.newSession(); } });
	}`;
	const f = await fixture(source);
	try {
		assert.deepEqual(f.worker.footerState().nested, { active: 1, cost: 0, incomplete: false, available: true });
		await f.worker.start("test"); await f.worker.waitForIdle();
		assert.equal(f.worker.footerState().active, false);
		assert.equal(f.worker.footerState().nested.cost, 2);
		f.worker.sessionManager().appendUsage("cache_warm", "test", "test", usage(0.5));
		await f.worker.reload();
		assert.equal(f.worker.footerState().spend.cost, 0.5);
		await f.worker.start("again"); await f.worker.waitForIdle();
		assert.equal(f.worker.footerState().spend.cost, 0.5);
		assert.equal(f.worker.footerState().nested.cost, 2);
		const previous = f.worker.sessionId();
		await f.worker.runCommand("fresh", "");
		assert.notEqual(f.worker.sessionId(), previous);
		assert.equal(f.worker.footerState().spend.cost, 0.5);
		assert.equal(f.worker.footerState().nested.cost, 2);
		await f.worker.close();
		assert.equal(f.worker.footerState().active, false);
		assert.equal(f.worker.footerState().nested.active, 0);
		assert.equal(f.worker.footerState().nested.available, false);
	} finally { await f.close(); }
});
