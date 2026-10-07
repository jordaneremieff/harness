/**
 * Surface tests for the primary controls and operator actions that carry
 * reset and timer operations to the host. A stub control records the method
 * and parameters; no host runs.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResetTimerActions, registerResetTimerTools, scheduleAgentInput } from "./durable-reset-timers.ts";

interface ControlCall {
	readonly method: string;
	readonly input: Record<string, unknown>;
}

function stubControl(calls: ControlCall[]): (method: string, input: Record<string, unknown>) => Promise<unknown> {
	return async (method, input) => {
		calls.push({ method, input });
		switch (method) {
			case "reset":
				return { conversationId: 1, requestId: input.requestId, submissionId: 4, status: "queued", entryId: null, reason: null, deduped: false };
			case "timer-schedule":
				return { timerId: 7, conversationId: 1, identity: "storage-a", deadline: input.deliverAt, mode: input.mode, origin: input.origin, scheduleId: input.scheduleId, deduped: false };
			case "timer-list":
				return { timers: [{ timerId: 7, scheduleId: "s", conversationId: 1, identity: "storage-a", messagePreview: "later", deadline: Date.now() + 60000, mode: "followUp", origin: "operator", ownerId: "owner", requestId: "r", createdAt: Date.now(), status: "pending", firedAt: null, overdueMs: null, submissionId: null, settledAt: null, live: true }] };
			case "timer-cancel":
				return { timerId: input.timerId, outcome: "marked", status: "cancelled" };
			default:
				throw new Error(`unexpected control ${method}`);
		}
	};
}

function surface(calls: ControlCall[]) {
	return { control: stubControl(calls), label: async () => "alpha" };
}

it("passes the optional self-owned schedule flag only when the caller supplies it", async () => {
	const calls: ControlCall[] = [];
	for (const selfOwned of [undefined, false, true]) {
		await scheduleAgentInput(surface(calls), { sessionId: "storage-a", message: "later", deliverAt: Date.now(), ...(selfOwned === undefined ? {} : { selfOwned }) });
		assert.equal(calls.at(-1)?.input.selfOwned, selfOwned);
		assert.equal(Object.hasOwn(calls.at(-1)?.input ?? {}, "selfOwned"), selfOwned !== undefined);
	}
});

it("registers the separate reset tool and leaves timers to agent_status and agent_abort", async () => {
	const calls: ControlCall[] = [];
	const tools = new Map<string, { execute: (callId: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown>; renderCall?: unknown; renderResult?: unknown }>();
	const pi = { registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as unknown as ExtensionAPI;
	registerResetTimerTools(pi, () => surface(calls));
	assert.deepEqual([...tools.keys()], ["agent_reset"]);
	const tool = tools.get("agent_reset");
	assert.ok(tool);
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
	await tool.execute("call-1", { sessionId: "storage-a", handoff: "new start" }, undefined, undefined, {});
	assert.deepEqual(calls.at(-1), { method: "reset", input: { sessionId: "storage-a", handoff: "new start" } });
});

it("runs the operator reset, schedule, list, and cancel actions with operator origin", async () => {
	const calls: ControlCall[] = [];
	const actions = new Map(createResetTimerActions(() => surface(calls)).map((action) => [action.name, action]));
	assert.deepEqual([...actions.keys()], ["reset", "schedule", "timers", "timer-cancel"]);
	const run = async (name: string, args: string[]): Promise<unknown> => {
		const action = actions.get(name);
		assert.ok(action, `${name} exists`);
		return await action.run(args, {} as never);
	};
	const reset = (await run("reset", ["storage-a", "fresh", "start"])) as { text: string };
	assert.match(reset.text, /Reset queued/u);
	assert.equal(calls.at(-1)?.method, "reset");
	assert.equal(calls.at(-1)?.input.handoff, "fresh start");
	const schedule = (await run("schedule", ["storage-a", "2026-10-03T09:00:00+10:00", "check", "back"])) as { text: string };
	assert.match(schedule.text, /Scheduled timer #7/u);
	const scheduled = calls.at(-1);
	assert.equal(scheduled?.method, "timer-schedule");
	assert.equal(scheduled?.input.message, "check back");
	assert.equal(scheduled?.input.mode, "followUp");
	assert.equal(scheduled?.input.origin, "operator");
	assert.equal(Object.hasOwn(scheduled?.input ?? {}, "selfOwned"), false, "primary and dashboard operator actions do not opt in");
	assert.equal(scheduled?.input.deliverAt, Date.parse("2026-10-03T09:00:00+10:00"));
	assert.equal(typeof scheduled?.input.scheduleId, "string");
	assert.equal(typeof scheduled?.input.requestId, "string");
	const listed = (await run("timers", ["storage-a"])) as { text: string };
	assert.match(listed.text, /#7 pending/u);
	const cancelled = (await run("timer-cancel", ["storage-a", "7"])) as { text: string };
	assert.match(cancelled.text, /Cancelled timer #7/u);
	assert.equal(calls.at(-1)?.method, "timer-cancel");
	assert.equal(calls.at(-1)?.input.timerId, 7);
});
