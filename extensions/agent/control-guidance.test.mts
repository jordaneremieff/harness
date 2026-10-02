/**
 * control-guidance tests: the shared model-facing delegation guidance.
 *
 * The map must cover the current controls, keep the operator-approved baseline
 * wording, and change only the delivery semantics that differ in Pi Durable.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { AGENT_CONTROL_GUIDANCE, AGENT_CONTROL_TOOL_NAMES, agentControlGuidanceLines } from "./control-guidance.ts";

const CURRENT_TOOLS = [
	"agent_abort",
	"agent_attach",
	"agent_command",
	"agent_compact",
	"agent_configure",
	"agent_fork",
	"agent_inspect",
	"agent_list",
	"agent_place",
	"agent_rewind",
	"agent_send",
	"agent_spawn",
	"agent_status",
	"agent_steer",
];

it("covers every current control and no removed surface", () => {
	assert.deepEqual([...AGENT_CONTROL_TOOL_NAMES].sort(), CURRENT_TOOLS);
	for (const name of AGENT_CONTROL_TOOL_NAMES) {
		assert.ok(AGENT_CONTROL_GUIDANCE[name], `${name} has a guidance entry`);
	}
	assert.ok(!Object.hasOwn(AGENT_CONTROL_GUIDANCE, "agent_detach"), "detach has no entry");
	assert.ok(!Object.hasOwn(AGENT_CONTROL_GUIDANCE, "agent_runs"), "runs has no entry");
});

it("keeps the approved snippets", () => {
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_spawn.snippet, "Spawn a background full agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_send.snippet, "Send a task to an agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_steer.snippet, "Redirect a running agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_abort.snippet, "Abort an agent session operation");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_fork.snippet, "Fork an agent session for side work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_status.snippet, "Show agent session status");
	assert.equal(
		AGENT_CONTROL_GUIDANCE.agent_rewind.snippet,
		"Rewind an agent session to an entry and re-derive the work",
	);
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_place.snippet, "Work in the session bound to an area");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_attach.snippet, "Attach to a stored agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_configure.snippet, "Configure an idle session without starting work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_list.snippet, "Find retained agent sessions");
});

it("keeps the contract, reporting, polling, live-work, and authority guidance", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.match(all, /objective, output format, source guidance, and boundaries/u);
	assert.match(all, /Intent authority/u);
	assert.match(all, /resolve live work/u);
	assert.match(all, /continue useful work, redirect changed work, or abort superseded work/u);
	assert.match(all, /interim reports, blocking questions, and corrections/u);
	assert.match(all, /Do not replace the terminal result with an interim report/u);
	assert.match(all, /Never poll with sleeps or repeated status\/inspection calls/u);
	assert.match(all, /Settlement notices arrive automatically/u);
});

it("changes only the durable delivery semantics", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.doesNotMatch(all, /ordinary terminal response/u);
	assert.doesNotMatch(all, /in-process settlement/u);
	assert.doesNotMatch(all, /session-ownership section/u);
	assert.match(
		AGENT_CONTROL_GUIDANCE.agent_spawn.guidelines?.[1] ?? "",
		/child's answer reports to the recorded owner conversation/u,
	);
	assert.match(AGENT_CONTROL_GUIDANCE.agent_send.guidelines?.[0] ?? "", /owner identity in its instructions/u);
});

it("renders only the selected controls in control order", () => {
	const lines = agentControlGuidanceLines(["agent_status", "agent_spawn"]);
	const text = lines.join("\n");
	assert.match(text, /- agent_spawn: Spawn a background full agent session/u);
	assert.match(text, /- agent_status: Show agent session status/u);
	assert.doesNotMatch(text, /- agent_place:/u);
	assert.ok(text.indexOf("agent_spawn") < text.indexOf("agent_status"), "order follows the control list");
});

it("keeps the no-polling guidance when only status is selected", () => {
	const text = agentControlGuidanceLines(["agent_status"]).join("\n");
	assert.match(text, /Never poll with sleeps/u);
	assert.doesNotMatch(text, /agent_spawn/u);
});

it("gives every control a snippet", () => {
	for (const name of AGENT_CONTROL_TOOL_NAMES) {
		const snippet = AGENT_CONTROL_GUIDANCE[name].snippet;
		assert.ok(snippet !== undefined && snippet.length > 0, `${name} has a snippet`);
	}
});

it("renders the compact, command, and inspect snippets", () => {
	const text = agentControlGuidanceLines(["agent_compact", "agent_command", "agent_inspect"]).join("\n");
	assert.match(text, /- agent_compact: /u);
	assert.match(text, /- agent_command: /u);
	assert.match(text, /- agent_inspect: /u);
});
