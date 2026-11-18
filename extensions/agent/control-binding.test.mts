/**
 * The process-global control binding between one Durable host runtime and the
 * contribution code loaded beside it. A native reload can pair new contribution
 * code with a retained older runtime, so the binding carries a version and a
 * mismatch refuses with both versions named.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AGENT_CONTROL_BINDING_KEY,
	AGENT_CONTROL_BINDING_VERSION,
	publishAgentControlDispatch,
	resolveAgentControlDispatch,
	type AgentControlDispatch,
} from "./durable-agents.ts";

const globals = globalThis as unknown as Record<PropertyKey, unknown>;

/** Restore the raw binding after one test, so sibling tests see no publication. */
function restoreAfter(t: { after(fn: () => void): void }): void {
	const previous = globals[AGENT_CONTROL_BINDING_KEY];
	t.after(() => {
		if (previous === undefined) delete globals[AGENT_CONTROL_BINDING_KEY];
		else globals[AGENT_CONTROL_BINDING_KEY] = previous;
	});
}

const noop: AgentControlDispatch = async () => null;

it("preserves the capable dispatch identity and refuses a bare function", (t) => {
	restoreAfter(t);
	globals[AGENT_CONTROL_BINDING_KEY] = { version: AGENT_CONTROL_BINDING_VERSION, dispatch: noop, playbookControlContract: "agent-playbooks/1" };
	assert.equal(resolveAgentControlDispatch(), noop);
	globals[AGENT_CONTROL_BINDING_KEY] = noop;
	assert.throws(() => resolveAgentControlDispatch(), /malformed/u, "a pre-versioning bare function refuses");
});

it("guards playbook calls on a trusted legacy binding and forwards its other controls unchanged", async (t) => {
	restoreAfter(t);
	const calls: Parameters<AgentControlDispatch>[] = [];
	const receipt = { accepted: true };
	const legacy: AgentControlDispatch = async (...args) => { calls.push(args); return receipt; };
	globals[AGENT_CONTROL_BINDING_KEY] = { version: AGENT_CONTROL_BINDING_VERSION, dispatch: legacy };
	const dispatch = resolveAgentControlDispatch();
	assert.notEqual(dispatch, legacy);
	const target = { sessionId: "target" };
	assert.equal(await dispatch("playbook-read", target, BACKGROUND_CONTEXT), undefined);
	await assert.rejects(dispatch("playbook-configure", target, BACKGROUND_CONTEXT), /does not support playbook controls.*matching host/u);
	for (const method of ["configure", "spawn", "resolve-agent"] as const) {
		await assert.rejects(dispatch(method, { ...target, playbook: "maker" }, BACKGROUND_CONTEXT), /does not support playbook controls.*matching host/u);
	}
	assert.deepEqual(calls, [], "unsupported controls never reach the legacy dispatch");
	for (const method of ["status", "submit", "configure", "spawn", "resolve-agent"] as const) {
		const params = { ...target, requestId: `legacy-${method}` };
		assert.equal(await dispatch(method, params, BACKGROUND_CONTEXT), receipt);
		const call = calls.pop();
		assert.equal(call?.[0], method);
		assert.equal(call?.[1], params);
		assert.equal(call?.[2], BACKGROUND_CONTEXT);
		assert.deepEqual(calls, []);
	}
});

it("refuses a mismatched binding with both versions and a restart", (t) => {
	restoreAfter(t);
	globals[AGENT_CONTROL_BINDING_KEY] = { version: AGENT_CONTROL_BINDING_VERSION + 1, dispatch: noop };
	assert.throws(
		() => resolveAgentControlDispatch(),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(`version ${AGENT_CONTROL_BINDING_VERSION + 1}`) &&
			error.message.includes(`requires version ${AGENT_CONTROL_BINDING_VERSION}`) &&
			error.message.includes("Restart the agent host"),
	);
	globals[AGENT_CONTROL_BINDING_KEY] = { version: 1, dispatch: noop };
	assert.throws(() => resolveAgentControlDispatch(), /malformed/u);
	globals[AGENT_CONTROL_BINDING_KEY] = { version: AGENT_CONTROL_BINDING_VERSION };
	assert.throws(() => resolveAgentControlDispatch(), /malformed/u);
	globals[AGENT_CONTROL_BINDING_KEY] = Symbol("foreign binding");
	assert.throws(() => resolveAgentControlDispatch(), /malformed/u);
	delete globals[AGENT_CONTROL_BINDING_KEY];
	assert.throws(() => resolveAgentControlDispatch(), /unavailable/u);
});

it("publishes and restores without clobbering a later runtime", (t) => {
	restoreAfter(t);
	delete globals[AGENT_CONTROL_BINDING_KEY];
	const first: AgentControlDispatch = async () => "first";
	const second: AgentControlDispatch = async () => "second";
	const restoreFirst = publishAgentControlDispatch(first);
	assert.equal(resolveAgentControlDispatch(), first);
	const restoreSecond = publishAgentControlDispatch(second);
	assert.equal(resolveAgentControlDispatch(), second);
	restoreFirst();
	assert.equal(resolveAgentControlDispatch(), second, "a stale restore keeps the later runtime binding");
	restoreSecond();
	assert.equal(resolveAgentControlDispatch(), first, "the later restore returns to the publication it replaced");
	restoreFirst();
	assert.equal(globals[AGENT_CONTROL_BINDING_KEY], undefined, "the earlier restore clears its own publication");
});
