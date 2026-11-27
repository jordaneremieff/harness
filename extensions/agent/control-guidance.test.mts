/**
 * control-guidance tests: the shared model-facing delegation guidance.
 *
 * Coverage, delivery semantics, and deduplication for selected controls.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import {
	AGENT_CONTROL_EXPOSURE,
	AGENT_CONTROL_GUIDANCE,
	AGENT_CONTROL_TOOL_NAMES,
	agentControlGuidance,
	agentControlGuidanceLines,
} from "./control-guidance.ts";

it("ordinary delegation guidance names only registered controls and native guidance retains open-work declarations", async () => {
	const tools = new Map<string, { description: string; promptGuidelines?: string[] }>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerFlag() {},
		registerTool: (tool: { name: string; description: string; promptGuidelines?: string[] }) =>
			tools.set(tool.name, tool),
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		registerCommand() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.equal(tools.has("agent_yield"), true, "an ordinary session has its own agent_yield");
	assert.equal(
		tools.has("agent_work"),
		false,
		"the native agent_work, which declares background work, is not an ordinary session's tool",
	);
	for (const [name, tool] of tools) {
		const text = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
		for (const mentioned of text.matchAll(/\bagent_[a-z]+\b/gu))
			assert.ok(tools.has(mentioned[0]), `${name} names unavailable ${mentioned[0]}`);
	}
	const stop = tools.get("agent_abort");
	assert.match(stop?.description ?? "", /plain stop spares spawned children/u);
	assert.match(stop?.description ?? "", /background: true[^.]*in this storage, never other storages/u);
	for (const name of ["agent_spawn", "agent_send"] as const) {
		const actual = tools.get(name)?.promptGuidelines;
		assert.deepEqual(actual, agentControlGuidance(name, "ordinary").guidelines);
		const ordinary = actual?.join("\n") ?? "";
		assert.match(ordinary, /call agent_yield with a short note for the operator/u);
		assert.doesNotMatch(
			ordinary,
			/background job|nothing (is )?(needed|needs) (from )?you|needs? nothing from/iu,
			"no job vocabulary and no pseudo-state line",
		);
		assert.doesNotMatch(
			ordinary,
			/agent_work complete|widget|exact result references|Preserve known request IDs/u,
			"the note is operator text: it is no stored state and carries no result reference",
		);
		assert.match(ordinary, /in the last batch; every call must end the turn\. Write no chat text\./u);
		assert.match(
			ordinary,
			/while agents work, chat only for an operator decision or action, a blocker, or a result; let it stand alone/u,
		);
		assert.doesNotMatch(ordinary, /short state note/u);
		assert.match(ordinary, /Results arrive as events/u);
		assert.match(ordinary, /Never sleep, poll or hold a foreground command open/u);
		assert.doesNotMatch(
			ordinary,
			/the request and its exact result references|final report/u,
			"the ordinary contract has no routed request and no final report",
		);
		const native = agentControlGuidance(name, "native").guidelines?.join("\n") ?? "";
		assert.match(native, /agent_work continue/u);
	}
	assert.match(agentControlGuidance("agent_send", "native").guidelines?.join("\n") ?? "", /agent_work complete/u);
});

const CURRENT_TOOLS = [
	"agent_abort",
	"agent_attach",
	"agent_brief",
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
		assert.match(text, /Creation uses defaultPreset unless selected/u);
		assert.match(text, /verify exact provider\/model and supported thinking/u);
		assert.match(text, /Otherwise use preset resolution/u);
		assert.match(text, /Respect route, budget and role/u);
		assert.doesNotMatch(text, /^Use an exact/u);
		assert.match(text, /explicit fields win/u);
		assert.match(text, /Configure retains unspecified target values/u);
		assert.match(text, /No parent inheritance/u);
		assert.match(text, /Receipts identify overrides/u);
		assert.match(text, /Exclusions advise unless enforceRoster is true on creation/u);
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
	assert.match(
		(AGENT_CONTROL_GUIDANCE.agent_abort.guidelines ?? []).join(" "),
		/Do not combine release with timerId or background: true/u,
	);
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_fork.snippet, "Fork an agent session for side work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_status.snippet, "Show agent session status");
	assert.equal(
		AGENT_CONTROL_GUIDANCE.agent_rewind.snippet,
		"Rewind an agent session to an entry and re-derive the work",
	);
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_place.snippet, "Work in the session bound to an area");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_reset.snippet, "Reset an agent's active context with an optional handoff");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_attach.snippet, "Attach to a stored agent session");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_configure.snippet, "Configure a session without starting work");
	assert.equal(AGENT_CONTROL_GUIDANCE.agent_list.snippet, "Find retained agent sessions");
	assert.equal(
		AGENT_CONTROL_GUIDANCE.agent_intent.snippet,
		"Read related efforts or publish or clear your integration intent",
	);
});

it("keeps the contract, reporting, polling, live-work, and authority guidance", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.match(all, /Provide objective, endCondition and result/u);
	assert.match(all, /carry each operator decision with its source, scope, and restrictions/u);
	assert.match(all, /Say whether a correction comes from the operator or from you/u);
	assert.doesNotMatch(all, /AGENTS\.md|Intent authority/u);
	assert.match(all, /Integrate required results before claiming completion/u);
	assert.match(all, /A receipt is not a result; settlement is not acceptance/u);
	assert.match(all, /spare unrelated agents/u);
	assert.match(all, /Continue useful work, redirect changed work or abort superseded work/u);
	assert.match(all, /Send progress and blocking questions/u);
	assert.match(all, /only agent_work complete sends the final report to the original recipient/u);
	assert.match(all, /Each request retains its route/u);
	assert.match(all, /Answer with the result or exact blocker/u);
	assert.match(all, /start the state note by saying it is not the result/u);
	assert.match(all, /Never poll with sleeps or repeated reads/u);
	assert.match(all, /results arrive automatically/u);
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
	assert.match(send, /call agent_work continue with the request and exact admitted result references/u);
	assert.match(send, /Arrivals resume work/u);
	assert.match(send, /Never sleep, poll or chain long foreground calls/u);
	assert.doesNotMatch(send, /agent_await|waits for the current run to end/u);
});

it("describes retained delivery and opt-in unfinished-task check-ins", () => {
	const all = JSON.stringify(AGENT_CONTROL_GUIDANCE);
	assert.doesNotMatch(all, /ordinary terminal response/u);
	assert.doesNotMatch(all, /in-process settlement/u);
	assert.doesNotMatch(all, /session-ownership section/u);
	assert.match(
		AGENT_CONTROL_GUIDANCE.agent_spawn.guidelines?.join("\n") ?? "",
		/task's answer routes to its request's reply recipient/u,
	);
	assert.match(
		AGENT_CONTROL_GUIDANCE.agent_send.guidelines?.[0] ?? "",
		/mode: report to the current request's reply recipient/u,
	);
	assert.match(all, /using the task route, not creator provenance/u);
	assert.match(all, /expectedRevision/u);
	assert.match(all, /before relying on past findings/u);
	assert.match(all, /Results arrive without check-ins/u);
	assert.match(all, /agent\.checkInMinutes defaults to 0/u);
	assert.match(all, /Check-ins wake model owners only/u);
	assert.doesNotMatch(all, /default 30/u);
	assert.match(all, /a check-in is not a result/u);
});

it("teaches substantial assignments through a checked brief", () => {
	const tools = agentControlGuidanceLines(["agent_send", "agent_brief", "agent_spawn"]).join("\n");
	assert.match(tools, /Use agent_brief for substantial tasks/u);
	assert.match(tools, /- agent_brief: Brief an agent with a checked, standard task brief/u);
	assert.match(tools, /Provide objective, endCondition and result/u);
	assert.match(tools, /Quote operator decisions with source and scope/u);
	assert.match(tools, /Use preview to check without dispatch/u);
	assert.equal(AGENT_CONTROL_TOOL_NAMES.indexOf("agent_brief"), AGENT_CONTROL_TOOL_NAMES.indexOf("agent_spawn") + 1);
});

it("teaches nested spawn placement and lineage status", () => {
	const spawn = AGENT_CONTROL_GUIDANCE.agent_spawn.guidelines?.join("\n") ?? "";
	assert.match(spawn, /without a handle shares storage in the same cwd/u);
	assert.match(spawn, /another cwd starts a new host/u);
	assert.ok(spawn.includes("Children may delegate"));
	assert.ok(spawn.includes("appear in /agent"));
	const status = AGENT_CONTROL_GUIDANCE.agent_status.guidelines?.join("\n") ?? "";
	assert.match(status, /not host inventory, effort awareness or created-agent detail/u);
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

it("renders shared rules once without depending on an unselected control", () => {
	const selected = agentControlGuidanceLines(["agent_spawn", "agent_send", "agent_configure", "agent_place"]).join(
		"\n",
	);
	for (const rule of [
		/Override only for the task/gu,
		/Creation uses defaultPreset unless selected/gu,
		/When no independent work remains/gu,
		/Set checkInMinutes only for a watchdog/gu,
	]) {
		assert.equal([...selected.matchAll(rule)].length, 1);
	}
	for (const name of ["agent_spawn", "agent_send"]) {
		const text = agentControlGuidanceLines([name]).join("\n");
		assert.match(text, /agent_work continue with the request and exact admitted result references/u);
		assert.match(text, /Set checkInMinutes only for a watchdog/u);
	}
	for (const name of ["agent_spawn", "agent_configure", "agent_place"]) {
		assert.match(agentControlGuidanceLines([name]).join("\n"), /Creation uses defaultPreset unless selected/u);
	}
});

it("scopes handle reuse and thread discovery to choices made for the task", () => {
	const spawn = agentControlGuidanceLines(["agent_spawn"]).join("\n");
	assert.match(spawn, /When delegating a recurring concern/u);
	assert.match(spawn, /reuse keeps its settings/u);
	const thread = agentControlGuidanceLines(["agent_collaborate"]).join("\n");
	assert.match(thread, /If a shared thread would help/u);
	assert.match(thread, /Post or close in one call up to 24,000 UTF-16 units/u);
	assert.match(thread, /Notify only for needed attention/u);
	assert.match(thread, /Brief new agents before notify/u);
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
		[
			"agent_abort",
			"agent_brief",
			"agent_collaborate",
			"agent_inspect",
			"agent_intent",
			"agent_list",
			"agent_profile",
			"agent_send",
			"agent_spawn",
			"agent_status",
			"agent_steer",
		],
	);
	assert.deepEqual(
		Object.entries(AGENT_CONTROL_EXPOSURE)
			.filter(([, exposure]) => exposure === "deferred")
			.map(([name]) => name)
			.sort(),
		["agent_attach", "agent_command", "agent_configure", "agent_fork", "agent_place", "agent_reset", "agent_rewind"],
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

it("declares the controls that results and instructions name as the next call and names the deferred rest", () => {
	// Status results, result deliveries and the native profile instruction name these as the next call.
	for (const name of ["agent_inspect", "agent_list", "agent_profile"] as const)
		assert.notEqual(AGENT_CONTROL_EXPOSURE[name], "deferred", `${name} is declared`);
	for (const surface of ["ordinary", "native"] as const) {
		const status = agentControlGuidance("agent_status", surface).guidelines?.join("\n") ?? "";
		const deferred = AGENT_CONTROL_TOOL_NAMES.filter((name) => AGENT_CONTROL_EXPOSURE[name] === "deferred");
		for (const name of deferred) assert.ok(status.includes(name), `${surface} status guidance names ${name}`);
		assert.match(status, /load it with tool_search before you call it/u);
	}
});
