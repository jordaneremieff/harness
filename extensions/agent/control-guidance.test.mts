/**
 * control-guidance tests: the shared model-facing delegation guidance.
 *
 * The map must cover the current controls, keep the operator-approved baseline
 * wording, and change only the delivery semantics that differ in Pi Durable.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AGENT_CONTROL_EXPOSURE, AGENT_CONTROL_GUIDANCE, AGENT_CONTROL_TOOL_NAMES, agentControlGuidance, agentControlGuidanceLines } from "./control-guidance.ts";

it("ordinary delegation guidance names only registered controls and native guidance retains open-work declarations", async () => {
	const tools = new Map<string, { description: string; promptGuidelines?: string[] }>();
	await register({
		events: { emit() {}, on: () => () => {} }, on: () => () => {},
		registerTool: (tool: { name: string; description: string; promptGuidelines?: string[] }) => tools.set(tool.name, tool),
		registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.equal(tools.has("agent_work"), true, "an ordinary session has its own agent_work");
	for (const [name, tool] of tools) {
		const text = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
		for (const mentioned of text.matchAll(/\bagent_[a-z]+\b/gu)) assert.ok(tools.has(mentioned[0]), `${name} names unavailable ${mentioned[0]}`);
	}
	for (const name of ["agent_spawn", "agent_send"] as const) {
		const actual = tools.get(name)?.promptGuidelines;
		assert.deepEqual(actual, agentControlGuidance(name, "ordinary").guidelines);
		const ordinary = actual?.join("\n") ?? "";
		assert.match(ordinary, /agent_work continue .*as the only call of your last tool batch, and write no chat text/u);
		assert.match(ordinary, /A chat message is only for a decision or act of the operator, a blocker, or a result, and it stands alone/u);
		assert.doesNotMatch(ordinary, /short state note/u);
		assert.match(ordinary, /Results arrive as events/u);
		assert.match(ordinary, /no repeated status or inspection call/u);
		assert.doesNotMatch(ordinary, /the request and its exact result references|final report/u, "the ordinary contract has no routed request and no final report");
		const native = agentControlGuidance(name, "native").guidelines?.join("\n") ?? "";
		assert.match(native, /agent_work continue/u);
	}
	assert.match(agentControlGuidance("agent_send", "native").guidelines?.join("\n") ?? "", /agent_work complete/u);
});

const CURRENT_TOOLS = [
	"agent_abort",
	"agent_attach",
	"agent_collaborate",
	"agent_command",
	"agent_compact",
	"agent_configure",
	"agent_fork",
	"agent_inspect",
	"agent_intent",
	"agent_list",
	"agent_place",
	"agent_profile",
	"agent_reset",
	"agent_rewind",
	"agent_send",
	"agent_spawn",
	"agent_status",
	"agent_steer",
];

it("limits preset advice to supported controls and distinguishes target retention from inheritance", () => {
	for (const name of ["agent_spawn", "agent_place", "agent_configure"] as const) {
		const text = AGENT_CONTROL_GUIDANCE[name].guidelines?.join("\n") ?? "";
		assert.match(text, /Delegate with preset/u);
		assert.match(text, /For an explicit model override, use an exact provider\/model identity/u);
		assert.match(text, /resolver owns preset and default identity selection/u);
		assert.match(text, /route, budget, and role preferences before choosing the override/u);
		assert.doesNotMatch(text, /^Use an exact/u);
		assert.match(text, /Omit model and preset.*defaultPreset/u);
		assert.match(text, /Explicit fields win over preset fields/u);
		assert.match(text, /Configure retains the target's own values/u);
		assert.match(text, /never inherits parent execution settings/u);
		assert.match(text, /receipts record explicit overrides/u);
		assert.match(text, /advisory unless the operator sets enforceRoster true/u);
		assert.match(text, /role applies only to handle creation/u);
	}
	assert.doesNotMatch((AGENT_CONTROL_GUIDANCE.agent_send.guidelines ?? []).join("\n"), /preset/u);
	assert.doesNotMatch((AGENT_CONTROL_GUIDANCE.agent_attach.guidelines ?? []).join("\n"), /preset/u);
});

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
	assert.match((AGENT_CONTROL_GUIDANCE.agent_abort.guidelines ?? []).join(" "), /release: true/u);
	assert.match((AGENT_CONTROL_GUIDANCE.agent_abort.guidelines ?? []).join(" "), /Do not combine release with timerId or background: true/u);
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_fork.snippet, "Fork an agent session for side work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_status.snippet, "Show agent session status");
	assert.equal(
		AGENT_CONTROL_GUIDANCE.agent_rewind.snippet,
		"Rewind an agent session to an entry and re-derive the work",
	);
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_place.snippet, "Work in the session bound to an area");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_reset.snippet, "Reset an agent's active context with an optional handoff");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_attach.snippet, "Attach to a stored agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_configure.snippet, "Configure an idle session without starting work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_list.snippet, "Find retained agent sessions");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_intent.snippet, "Publish or clear your integration intent");
});

it("keeps the contract, reporting, polling, live-work, and authority guidance", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.match(all, /objective, output format, source guidance, and boundaries/u);
	assert.match(all, /Intent authority/u);
	assert.match(all, /Resolve live work for this request/u);
	assert.match(all, /delegated results required by this request before claiming completion/u);
	assert.match(all, /a spawn or send receipt is not that result/u);
	assert.match(all, /Do not stop unrelated, standing, or background agents merely to finish this request/u);
	assert.match(all, /continue useful work, redirect changed work, or abort superseded work/u);
	assert.match(all, /informational reports and blocking questions/u);
	assert.match(all, /only agent_work complete sends the final report, to the original reply recipient/u);
	assert.match(all, /A terminal answer settles the current request/u);
	assert.match(all, /give the substantive result or exact blocker/u);
	assert.match(all, /state note whose first words say that it is not the result/u);
	assert.match(all, /Never poll with sleeps or repeated status\/inspection calls/u);
	assert.match(all, /Settlement notices arrive automatically/u);
	assert.match(all, /report to a running agent is placed at the recipient's next tool boundary/u);
	assert.match(all, /Use steer when the recipient must change its current work/u);
});

it("places follow-ups and reports at tool boundaries without holding the run", () => {
	const send = AGENT_CONTROL_GUIDANCE.agent_send.guidelines?.join("\n") ?? "";
	assert.match(send, /followUp to a running agent is placed at the recipient's next tool boundary/u);
	assert.match(send, /end of its current round of tool calls, not at the end of its run/u);
	assert.match(send, /both inputs may share one answer/u);
	assert.match(send, /report to a running agent is placed at the recipient's next tool boundary/u);
	assert.match(send, /It does not interrupt a running tool, and it starts no answer-bearing task/u);
	assert.match(send, /A report is an event for the recipient/u);
	assert.match(send, /declare the open work with agent_work continue/u);
	assert.match(send, /Each result, report, or message starts your next run/u);
	assert.match(send, /Never hold a run open for agent output/u);
	assert.doesNotMatch(send, /agent_await|waits for the current run to end/u);
});


it("describes retained delivery and opt-in unfinished-task check-ins", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.doesNotMatch(all, /ordinary terminal response/u);
	assert.doesNotMatch(all, /in-process settlement/u);
	assert.doesNotMatch(all, /session-ownership section/u);
	assert.match(
		AGENT_CONTROL_GUIDANCE.agent_spawn.guidelines?.join("\n") ?? "",
		/task's answer reports to its request's reply recipient/u,
	);
	assert.match(AGENT_CONTROL_GUIDANCE.agent_send.guidelines?.[0] ?? "", /mode: report to the current request's reply recipient/u);
	assert.match(all, /creating owner is provenance/u);
	assert.match(all, /expectedRevision/u);
	assert.match(all, /before relying on past findings/u);
	assert.match(all, /Results arrive without supervision turns/u);
	assert.match(all, /agent\.checkInMinutes default is 0/u);
	assert.match(all, /Check-ins wake a model owner, not an operator owner/u);
	assert.doesNotMatch(all, /default 30/u);
	assert.match(all, /not a finished result/u);
});

it("teaches nested spawn placement and lineage status", () => {
	const spawn = AGENT_CONTROL_GUIDANCE.agent_spawn.guidelines?.join("\n") ?? "";
	assert.match(spawn, /without a handle in the same cwd creates a conversation in your storage/u);
	assert.match(spawn, /a storage with its own host/u);
	assert.match(spawn, /selected controls permit further delegation/u);
	assert.ok(spawn.includes("bounded /agent roster"));
	const status = AGENT_CONTROL_GUIDANCE.agent_status.guidelines?.join("\n") ?? "";
	assert.match(status, /names what it omits: host inventory, effort awareness and created-agent detail/u);
	assert.doesNotMatch(status, /Created agents section/u);
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

it("keeps frequent controls direct and defers infrequent ones", () => {
	assert.deepEqual(
		Object.entries(AGENT_CONTROL_EXPOSURE)
			.filter(([, exposure]) => exposure === "direct")
			.map(([name]) => name)
			.sort(),
		["agent_abort", "agent_collaborate", "agent_intent", "agent_send", "agent_spawn", "agent_status", "agent_steer"],
	);
	assert.deepEqual(
		Object.entries(AGENT_CONTROL_EXPOSURE)
			.filter(([, exposure]) => exposure === "deferred")
			.map(([name]) => name)
			.sort(),
		["agent_attach", "agent_command", "agent_configure", "agent_fork", "agent_inspect", "agent_list", "agent_place", "agent_profile", "agent_reset", "agent_rewind"],
	);
	assert.deepEqual(
		Object.entries(AGENT_CONTROL_EXPOSURE)
			.filter(([, exposure]) => exposure === "model-only")
			.map(([name]) => name)
			.sort(),
		["agent_compact"],
	);
	assert.deepEqual(Object.keys(AGENT_CONTROL_EXPOSURE).sort(), CURRENT_TOOLS);
});

it("renders the compact, command, and inspect snippets", () => {
	const text = agentControlGuidanceLines(["agent_compact", "agent_command", "agent_inspect"]).join("\n");
	assert.match(text, /- agent_compact: /u);
	assert.match(text, /- agent_command: /u);
	assert.match(text, /- agent_inspect: /u);
});
