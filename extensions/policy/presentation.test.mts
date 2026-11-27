import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { parseToolCallArguments, validateToolArguments } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { controlResult } from "./control.ts";
import { toolDisplay } from "./display.ts";
import { RuleRegistry } from "./local-rules.ts";
import { PolicyApproveParams, PolicyRulesParams, registerRuleTools } from "./tools.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const nativeTui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const revision = "0123456789ab";
const proposalId = "00000000-0000-4000-8000-000000000002";
function keys(t: TestContext, binding: KeyId | KeyId[] = "ctrl+g") {
	initTheme("dark", false);
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: binding, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}

function card(name: string, args: Record<string, unknown> = {}, tool?: ToolDefinition): ToolExecutionComponent {
	const definition = tool ?? toolDisplay().tools.find((entry) => entry.name === name);
	assert.ok(definition);
	return new ToolExecutionComponent(
		name,
		"fixture",
		args,
		{ outputPad: 1 },
		definition as ToolDefinition,
		ui,
		"/project",
	);
}

function rows(component: ToolExecutionComponent, width = 110): string[] {
	const rendered = component.render(width);
	assert.ok(rendered.every((line) => visibleWidth(line) <= width));
	return rendered.map((line) => stripVTControlCharacters(line).trimEnd()).filter(Boolean);
}

function screen(component: ToolExecutionComponent, width?: number): string {
	return rows(component, width).join("\n");
}

function text(value: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: value }], details, isError };
}

const draft = {
	operation: "add",
	id: "local.scan",
	purpose: "Bound command output.",
	authority: "steer-or-block",
	reason: "Preserve the task's output bound.",
	note: "Use a bounded scan.",
	match: { command: "sample-scan" },
};

async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "policy-card-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const registry = new RuleRegistry(dir, { catalog: [] });
	const registered = new Map<string, ToolDefinition>();
	registerRuleTools(
		{
			registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
			getAllTools: () => [],
			getActiveTools: () => [],
		} as unknown as ExtensionAPI,
		{ registry, loadRegistry: () => registry.snapshot(), getMode: () => "observe" },
	);
	const context = {
		cwd: "/project",
		sessionManager: { getSessionId: () => "policy-card" },
		tools: [],
		executeTool: async () => assert.fail("A card test must not run another tool"),
	} as unknown as ExtensionToolContext;
	return {
		async show(name: string, args: Record<string, unknown>) {
			const tool = registered.get(name);
			assert.ok(tool);
			const component = card(name, args, tool);
			try {
				const result = await tool.execute("fixture", args, undefined, undefined, context);
				component.updateResult({ ...result, isError: result.isError ?? false });
				return { component, result };
			} catch (error) {
				component.updateResult(text(String(error instanceof Error ? error.message : error), undefined, true));
				return { component, result: undefined };
			}
		},
	};
}

it("retains one live key hint before execution and then moves it after progress and settled evidence", (t) => {
	keys(t);
	const component = card("policy_propose", draft);
	assert.deepEqual(
		rows(component).map((row) => row.trimStart()),
		["policy_propose add local.scan", "... (ctrl+g to expand)"],
	);
	assert.match(rows(component).at(-1) ?? "", /\.\.\. \(ctrl\+g to expand\)$/);
	assert.doesNotMatch(screen(component), /Preserve the task|Use a bounded scan/);
	component.markExecutionStarted();
	assert.equal(screen(component).match(/to expand/g)?.length, 1);
	component.updateResult(text("Partial text"), true);
	assert.match(screen(component), /Submitting the proposal for review…\n.*ctrl\+g to expand/);
	assert.equal(screen(component).match(/to expand/g)?.length, 1);
	component.updateResult(
		text("Pending proposal. Model-only instructions.", { proposalId, proposalRevision: revision, state: "pending" }),
	);
	assert.deepEqual(
		rows(component).map((row) => row.trimStart()),
		[
			"policy_propose add local.scan",
			`Staged inert proposal ${proposalId} for operator approval.`,
			"... (ctrl+g to expand)",
		],
	);
	component.setExpanded(true);
	assert.match(screen(component), /authority steer-or-block · sample-scan command match/);
	assert.match(screen(component), new RegExp(`revision ${revision}`));
	assert.match(screen(component), /reason: Preserve the task's output bound\./);
	assert.match(screen(component), /Model-only instructions/);
	assert.doesNotMatch(screen(component), /to expand/);
});

it("does not advertise pre-result clicks or a result with no extra content", (t) => {
	keys(t, []);
	const component = card("policy_approve", {
		proposalId,
		proposalRevision: revision,
		effect: "block",
		authorization: "Approved the exact proposal.",
	});
	assert.doesNotMatch(screen(component), /expand|authorization/);
	component.updateResult(text("Approval transport error", undefined, true));
	assert.match(rows(component).at(-1) ?? "", /click to expand/);
	const simple = card("policy_control", { operation: "mode" });
	simple.updateResult(text("", { mode: "observe" }));
	assert.match(screen(simple), /Session is in observe mode\./);
	assert.doesNotMatch(screen(simple), /expand/);
	const shortError = card("policy_rules", { view: "health" });
	shortError.updateResult(text("Transport error", undefined, true));
	assert.doesNotMatch(screen(shortError), /expand/);
});

it("clips full IDs and paths at the real width and shows the entered arguments on expansion", (t) => {
	keys(t);
	const id = `call:${"x".repeat(250)}tail`;
	const inspect = card("policy_rules", { view: "explain", id });
	assert.ok(screen(inspect, 320).includes(id));
	assert.match(rows(inspect, 27)[0] ?? "", /…$/);
	inspect.setExpanded(true);
	assert.ok(screen(inspect, 320).includes(`id: ${id}`) || (rows(inspect, 320)[0] ?? "").endsWith(id));
	const path = join(homedir(), "data", `${"a".repeat(130)}.json`);
	const control = card("policy_control", { operation: "data-preview", path });
	assert.ok(screen(control, 250).includes(`~${path.slice(homedir().length)}`));
	assert.match(rows(control, 38)[0] ?? "", /…$/);
	control.setExpanded(true);
	assert.ok(screen(control, 250).includes(`path: ${path}`));
});

it("omits streaming placeholders and does not leak simulated input or operator explanation", (t) => {
	keys(t, []);
	for (const args of [
		{ view: "check" },
		{ view: "preview" },
		{ view: "preview", tool: "bash", input: { command: "private value" } },
	]) {
		assert.doesNotMatch(screen(card("policy_rules", args)), /pending|no cases|private value|\(empty\)|\(none\)/);
	}
	assert.doesNotMatch(
		screen(card("policy_propose", { operation: "replace", id: "local.rule" })),
		/expected revision pending/,
	);
	const replacement = card("policy_propose", {
		operation: "replace",
		id: "local.rule",
		authority: "exact",
		expectedRevision: revision,
		predicate: "fixed.example",
	});
	assert.equal(screen(replacement).trim(), "policy_propose replace local.rule");
	replacement.setExpanded(true);
	assert.match(screen(replacement), /authority exact · predicate fixed\.example · expected revision 0123456789ab/);
	const program = card("policy_propose", {
		operation: "add",
		id: "local.rule",
		authority: "exact",
		program: { note: "expanded only" },
	});
	assert.doesNotMatch(screen(program), /facts\/v1 program|expanded only/);
	program.setExpanded(true);
	assert.match(screen(program), /facts\/v1 program/);
});

it("renders actual policy tool returns without confusing durable decisions with session enforcement", async (t) => {
	keys(t);
	const { show } = await fixture(t);
	const submitted = await show("policy_propose", draft);
	const pending = submitted.result?.details as { proposalId: string; proposalRevision: string };
	assert.match(screen(submitted.component), /Staged inert proposal/);
	assert.ok(screen(submitted.component).includes(pending.proposalId));
	const lookup = await show("policy_rules", { id: pending.proposalId });
	assert.match(screen(lookup.component), /pending and inert/);
	const inspection = await show("policy_control", { operation: "inspect", id: draft.id });
	assert.match(screen(inspection.component), /Read inert pending proposal/);
	const approval = await show("policy_approve", {
		proposalId: pending.proposalId,
		proposalRevision: pending.proposalRevision,
		effect: "block",
		authorization: "Approved this exact draft as a block.",
	});
	assert.match(screen(approval.component), /Approved the proposal for local\.scan; enforcement is not confirmed\./);
	assert.doesNotMatch(screen(approval.component), /effect block|Session is in observe mode|Approved this exact draft/);
	approval.component.setExpanded(true);
	assert.match(screen(approval.component), /local\.scan · active · effect block/);
	assert.match(screen(approval.component), /Session is in observe mode\./);
	const active = await show("policy_rules", { id: draft.id });
	assert.match(screen(active.component), /Rule local\.scan is active \(block\)\./);
	const readback = await show("policy_control", { operation: "inspect", id: draft.id });
	assert.match(screen(readback.component), /Read stored rule local\.scan and its control revision\./);
	const refusal = await show("policy_control", { operation: "inspect", id: "local.absent" });
	assert.equal(refusal.result, undefined);
	assert.match(screen(refusal.component), /No rule or proposal named local\.absent/);
	assert.doesNotMatch(screen(refusal.component), /Control applied/);
	const domainAbsence = await show("policy_rules", { id: "local.absent" });
	assert.ok(domainAbsence.result);
	assert.match(screen(domainAbsence.component), /No rule or pending proposal found\./);
});

it("keeps dry-run allow, deny and corrections distinct from real execution", (t) => {
	keys(t);
	const component = card("policy_rules", { view: "preview", tool: "sample-scan", input: {} });
	for (const [denied, correctedInput, resultCorrected, expected] of [
		[true, false, false, "deny"],
		[false, true, false, "correct input"],
		[false, false, true, "correct result"],
		[false, true, true, "correct input and result"],
		[false, false, false, "allow"],
	] as const) {
		component.updateResult(
			text(
				JSON.stringify({
					preview: true,
					mode: "enforce",
					decision: { denied, correctedInput, resultCorrected },
					input: { matches: ["local.scan"], candidate: { key: "extended-only" } },
				}),
			),
		);
		assert.ok(screen(component).includes(`Dry run would ${expected} in enforce mode. No simulated tool ran.`));
		assert.doesNotMatch(screen(component), /matched local\.scan|extended-only/);
		component.setExpanded(true);
		assert.match(screen(component), /matched local\.scan/);
		component.setExpanded(false);
	}
	component.updateResult(text("[bad JSON]"));
	assert.match(screen(component), /Dry-run decision not established\./);
});

it("uses actual check diagnostics and does not treat a refused draft as a thrown error", async (t) => {
	keys(t);
	const { show } = await fixture(t);
	const refused = await show("policy_rules", { view: "check", draft: { operation: "add", id: "local.bad" } });
	assert.ok(refused.result);
	assert.match(screen(refused.component), /Draft not admitted \(1 error\)\. No authority changed\./);
	const admitted = await show("policy_rules", { view: "check", draft, effect: "steer" });
	assert.ok(admitted.result);
	assert.match(screen(admitted.component), /Draft admitted(?: \([^)]*\))?\. No authority changed\./);
});

it("distinguishes control read progress, partial artifacts, and an armed retry from execution", (t) => {
	keys(t);
	const read = card("policy_control", { operation: "inspect", id: "local.sample" });
	read.updateResult(text(""), true);
	assert.match(screen(read), /Inspecting the policy target/);
	assert.doesNotMatch(screen(read), /Applying/);
	const preview = card("policy_control", { operation: "data-preview", path: "sample.json" });
	preview.updateResult({
		...controlResult({ complete: false, path: "/project/sample.json", revision, boundary: "Review the source first." }),
		isError: false,
	});
	assert.match(screen(preview), /Previewed data metadata only; no data changed\./);
	assert.doesNotMatch(screen(preview), /Review the source|\[Complete artifact/);
	preview.setExpanded(true);
	assert.match(screen(preview), /\[Complete artifact exceeds the preview output bound\]/);
	const approve = card("policy_control", { operation: "action-approve", actionId: proposalId });
	approve.updateResult({
		...controlResult({ actionId: proposalId, state: "approved", uses: 1, mode: "enforce" }),
		isError: false,
	});
	assert.match(screen(approve), /Approved one unchanged retry\. This did not run the action\./);
	assert.doesNotMatch(screen(approve), /Session is in enforce mode\./);
	approve.setExpanded(true);
	assert.match(screen(approve), /Session is in enforce mode\./);
});

it("reports page scope and preserves the exact cursor and request selection on expansion", (t) => {
	keys(t);
	const cursor = "opaque".repeat(23);
	const args = { view: "data", id: "sample.binding", cursor: "prior" };
	const rules = card("policy_rules", args);
	rules.updateResult(
		text(JSON.stringify({ binding: { status: "available" }, rows: [] }), {
			page: { start: 2, returned: 2, total: 10, nextCursor: cursor },
		}),
	);
	assert.match(screen(rules), /Returned rows 3–4 of 10; more follow\./);
	assert.doesNotMatch(screen(rules), /\[|Next call:|prior/);
	rules.setExpanded(true);
	assert.ok(screen(rules, 240).includes(`Next call: policy_rules ${JSON.stringify({ ...args, cursor })}`));
	const range = { operation: "telemetry", since: "2026-11-08T04:00:00Z", until: "2026-11-08T05:00:00Z" };
	const telemetry = card("policy_control", range);
	telemetry.updateResult(
		text("Telemetry report", {
			records: 3,
			coverage: { status: "partial", pageStatus: "complete" },
			continuation: { nextCursor: cursor, olderSegments: "removed" },
			recording: { status: "unknown" },
		}),
	);
	assert.match(screen(telemetry), /Read 3 records on this telemetry page; more follow\. Coverage is partial\./);
	telemetry.setExpanded(true);
	assert.match(screen(telemetry), /\[Telemetry coverage is partial\]/);
	assert.ok(screen(telemetry, 330).includes(`Next call: policy_control ${JSON.stringify({ ...range, cursor })}`));
});

it("does not treat missing bounded telemetry as proof of no decision", (t) => {
	keys(t);
	const component = card("policy_rules", { view: "explain", id: "call:fixture" });
	component.updateResult(text(JSON.stringify({ callId: "fixture", records: [], partial: true })));
	assert.match(screen(component), /No observation found in the bounded read; the call decision is not established/);
	assert.match(screen(component), /Evidence is partial\./);
	component.setExpanded(true);
	assert.match(screen(component), /\[Recorded evidence is partial\]/);
	component.setExpanded(false);
	component.updateResult(text(JSON.stringify({ callId: "fixture", records: [{ decision: "deny" }], partial: false })));
	assert.match(screen(component), /Found 1 recorded observation for the call\./);
	assert.doesNotMatch(screen(component), /partial/);
});

it("keeps a long diagnostic behind one hint and clips a long first line", (t) => {
	keys(t);
	const component = card("policy_rules", { view: "health" });
	component.updateResult(text(`Could not read\n${"界".repeat(180)} tail`, undefined, true));
	const narrow = rows(component, 42);
	assert.equal(narrow.length, 3);
	assert.match(narrow[1] ?? "", /Could not read/);
	assert.match(narrow.at(-1) ?? "", /\.\.\. \(ctrl\+g to expand\)$/);
	assert.doesNotMatch(screen(component, 42), /界|tail/);
	component.setExpanded(true);
	assert.match(screen(component, 42), /tail/);
	assert.doesNotMatch(screen(component, 42), /expand/);
	component.setExpanded(false);
	component.updateResult(text(`${"A".repeat(90)}⟨diagnostic end⟩`, undefined, true));
	assert.match(rows(component, 40).at(-1) ?? "", /ctrl\+g to expand/);
	assert.doesNotMatch(screen(component, 40), /diagnostic end/);
});

it("keeps Pi's echoed validation arguments behind expansion, including unparseable input", (t) => {
	keys(t);
	const privateText = "disclosure fixture input";
	const calls: Array<{ name: string; parameters: object; payload: ReturnType<typeof parseToolCallArguments> }> = [
		{
			name: "policy_approve",
			parameters: PolicyApproveParams,
			payload: { arguments: { proposalId, proposalRevision: revision, effect: "invalid", authorization: privateText } },
		},
		{
			name: "policy_rules",
			parameters: PolicyRulesParams,
			payload: { arguments: { view: "invalid", input: { privateText } } },
		},
		{
			name: "policy_rules",
			parameters: PolicyRulesParams,
			payload: parseToolCallArguments(JSON.stringify(privateText)),
		},
	];
	for (const { name, parameters, payload } of calls) {
		const component = card(name, payload.arguments);
		assert.throws(
			() =>
				validateToolArguments(
					{ name, parameters, description: name },
					{ type: "toolCall", name, id: "fixture", ...payload },
				),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes(privateText));
				component.updateResult(text(error.message, undefined, true));
				return true;
			},
		);
		assert.match(screen(component), /Diagnostic hidden in collapsed view/);
		assert.doesNotMatch(screen(component), /disclosure fixture input|Received arguments/);
		assert.match(rows(component).at(-1) ?? "", /to expand/);
		component.setExpanded(true);
		assert.match(screen(component), /Received arguments:/);
		assert.match(screen(component), /disclosure fixture input/);
	}
});

it("strips terminal sequences and names a character cap independently of the producer cap", (t) => {
	keys(t);
	const component = card("policy_rules", { view: "authoring" });
	component.updateResult(text(`No \x1b[31mcontrol\u202e\x07 marks\n${"界".repeat(33_000)}\n[policy text truncated]`));
	const collapsed = screen(component, 160);
	assert.match(collapsed, /Read the policy authoring guide\. Output truncated\./);
	assert.doesNotMatch(collapsed, /No control marks|33017/);
	component.setExpanded(true);
	assert.match(screen(component, 160), /No control marks/);
	assert.match(screen(component, 160), /Policy output was truncated by the producer/);
	assert.match(screen(component, 160), /Truncated: showing 32000 of 33017 characters/);
	const raw = component.render(160).join("\n");
	assert.doesNotMatch(stripTerminalSequences(raw), /\u202e|\u0007/);
});
