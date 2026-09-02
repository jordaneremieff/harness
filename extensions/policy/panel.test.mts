import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type AgentRule, MAX_FIRE_SCAN_BYTES, SCHEMA_VERSION, type StateLine } from "./agent-rules.ts";
import {
	agentDetailLines,
	buildRuleRows,
	computePolicyPanes,
	draftRuleMessage,
	fireBreakdownLines,
	formatPolicyHistory,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	PolicyPanel,
	readRecentActivity,
	terminalSafe,
	type BuiltinRuleInfo,
	type PolicyActivityRecord,
	type PolicyPanelData,
	type RuleListRow,
} from "./panel.ts";
import { RULES } from "./shell-rules.ts";

const theme: never = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;

const builtins: BuiltinRuleInfo[] = RULES.map(({ id, note }) => ({ id, note }));

function agent(overrides: Partial<AgentRule> = {}): AgentRule {
	return {
		version: SCHEMA_VERSION,
		slug: "no-force-push",
		note: "Use a reviewed push instead.",
		match: { tool: "bash", command: "git", flags: ["force"], operands: { at: { "0": "push" } } },
		suggest: { command: "git", flags: ["force-with-lease"] },
		scope: { providers: ["openai-codex"] },
		state: "active",
		model: "openai-codex/gpt-5.6-sol",
		session: "session-author",
		at: "2026-09-01T07:00:00.000Z",
		...overrides,
	};
}

function activity(overrides: Partial<PolicyActivityRecord> = {}): PolicyActivityRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		tool: "bash",
		classes: ["agent.no-force-push", "bounds.false-cap"],
		blocked: true,
		error: true,
		captured: "git push --force [REDACTED]",
		policyMode: "enforce",
		session: "session-observed",
		...overrides,
	};
}

function data(overrides: Partial<PolicyPanelData> = {}): PolicyPanelData {
	return {
		agentRules: [agent()],
		builtins,
		fireSummary: {
			fires: new Map([
				["agent.no-force-push", 4],
				["routing.cat-read", 3],
				["form.grep-file", 2],
				["bounds.false-cap", 5],
			]),
			firesByModel: new Map([
				[
					"agent.no-force-push",
					new Map([
						["openai-codex/gpt-5.6-sol", 3],
						["anthropic/claude-opus", 1],
					]),
				],
				[
					"routing.cat-read",
					new Map([
						["openai-codex/gpt-5.6-sol", 2],
						[null, 1],
					]),
				],
			]),
			partial: false,
		},
		activity: {
			records: [activity()],
			partial: false,
			byteLimited: false,
			recordLimited: false,
			bytesRead: 200,
		},
		...overrides,
	};
}

function rig(panelData = data(), rows = 24, copyRule?: (rule: AgentRule) => Promise<void>) {
	const calls = { renders: 0, done: undefined as unknown, copied: [] as string[] };
	const panel = new PolicyPanel({
		data: panelData,
		theme,
		tui: { requestRender: () => calls.renders++ },
		getMaxRows: () => rows,
		now: new Date("2026-09-03T12:00:00.000Z"),
		copyRule:
			copyRule ??
			(async (rule) => {
				calls.copied.push(rule.slug);
			}),
		done: (result) => {
			calls.done = result;
		},
	});
	return { panel, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function recordLine(record: PolicyActivityRecord): string {
	return `${JSON.stringify(record)}\n`;
}

describe("policy rule formatting", () => {
	it("orders agent rules before exactly three collapsed built-in groups", () => {
		const rows = buildRuleRows([agent()], builtins, data().fireSummary.fires, new Set());
		assert.equal(rows[0].kind, "agent");
		assert.deepEqual(
			rows.slice(1).map((row) => (row.kind === "group" ? row.group : row.kind)),
			["routing", "form", "bounds"],
		);
		const routing = rows.find((row) => row.kind === "group" && row.group === "routing");
		assert.equal(routing?.kind, "group");
		assert.equal(routing.fires, 3);
	});

	it("expands one group in place with each id, note, and own count", () => {
		const rows = buildRuleRows([], builtins, data().fireSummary.fires, new Set(["routing"]));
		assert.equal(rows[0].kind, "group");
		const builtinRows = rows.filter((row): row is Extract<RuleListRow, { kind: "builtin" }> => row.kind === "builtin");
		const routingChildren = builtinRows.filter((row) => row.group === "routing");
		assert.ok(routingChildren.length > 0);
		assert.equal(routingChildren[0].rule.id.startsWith("routing."), true);
		assert.ok(routingChildren[0].rule.note.length > 0);
		assert.equal(routingChildren.find((row) => row.rule.id === "routing.cat-read")?.fires, 3);
		assert.equal(rows.find((row) => row.kind === "group" && row.group === "form") !== undefined, true);
	});

	it("formats full detail and required fire evidence by model", () => {
		const summary = data().fireSummary;
		const lines = agentDetailLines(agent(), summary).join("\n");
		for (const expected of [
			"Use a reviewed push instead.",
			'"command": "git"',
			"suggested form",
			"scope",
			"openai-codex/gpt-5.6-sol",
			"session-author",
			"2026-09-01T07:00:00.000Z",
			"fires by model",
			"anthropic/claude-opus: 1",
		]) {
			assert.ok(lines.includes(expected), expected);
		}
		assert.deepEqual(fireBreakdownLines(summary, "routing.cat-read"), [
			"  openai-codex/gpt-5.6-sol: 2",
			"  (no model): 1",
		]);
	});

	it("prints agent columns, built-in groups, and full show text", () => {
		const panelData = data();
		const listed = formatPolicyList(panelData, new Date("2026-09-03T12:00:00.000Z"));
		for (const heading of ["origin", "slug", "state", "posture", "scope", "fires", "author model", "age"]) {
			assert.ok(listed.includes(heading), heading);
		}
		for (const group of ["routing", "form", "bounds"]) assert.match(listed, new RegExp(`^${group} \\|`, "m"));
		const shown = formatPolicyShow(panelData, "no-force-push") ?? "";
		assert.match(shown, /fires by model:/);
		assert.match(shown, /openai-codex\/gpt-5\.6-sol: 3/);
		assert.match(formatPolicyShow(panelData, "routing.cat-read") ?? "", /Use the read tool/);
	});

	it("formats state history newest first with legacy origins and warrant evidence", () => {
		const lines: StateLine[] = [
			{
				slug: "no-force-push",
				state: "active",
				model: "model/old",
				session: "session-old",
				at: "2026-09-01T07:00:00.000Z",
				origin: "unknown",
			},
			{
				slug: "no-force-push",
				state: "promoted",
				model: "model/new",
				session: "session-new",
				at: "2026-09-02T07:00:00.000Z",
				origin: "command",
				warrant: {
					criteria: 1,
					fires: 5,
					errors: 3,
					errorKinds: { timeout: 1, aborted: 1, other: 1 },
					truncated: 2,
					partial: false,
					pass: true,
				},
			},
		];
		const formatted = formatPolicyHistory(lines);
		assert.ok(formatted.indexOf("model/new") < formatted.indexOf("model/old"));
		assert.match(formatted, /origin: unknown/);
		assert.match(formatted, /warrant: criteria v1 pass · 5 fires · 3 errors · 2 truncated · scan complete/);
		assert.equal(formatPolicyHistory([]), "No state transitions were recorded.");
	});

	it("marks a promotion whose recorded warrant does not read", () => {
		const formatted = formatPolicyHistory([
			{
				slug: "no-force-push",
				state: "promoted",
				model: "model/new",
				session: "session-new",
				at: "2026-09-02T07:00:00.000Z",
				origin: "unknown",
				warrantUnreadable: true,
			},
		]);
		assert.match(formatted, /origin: unknown/);
		assert.match(formatted, /warrant: unreadable/);
	});

	it("keeps equal-timestamp history entries stable", () => {
		const common = {
			slug: "same-time",
			state: "active" as const,
			model: "model/id",
			at: "2026-09-01T07:00:00.000Z",
			origin: "tool" as const,
		};
		const formatted = formatPolicyHistory([
			{ ...common, session: "first" },
			{ ...common, session: "second" },
		]);
		assert.ok(formatted.indexOf("session: first") < formatted.indexOf("session: second"));
	});

	it("surfaces the shared fire-scan byte bound when counts are partial", () => {
		const partial = data({ fireSummary: { ...data().fireSummary, partial: true } });
		assert.match(formatPolicyShow(partial, "routing.cat-read") ?? "", new RegExp(String(MAX_FIRE_SCAN_BYTES)));
		assert.match(formatPolicyList(partial), /firing counts partial/);
	});
});

describe("PolicyPanel", () => {
	it("renders the Rules view with all agent columns and a detail pane", () => {
		const { panel } = rig();
		const lines = panel.render(140);
		const rendered = lines.join("\n");
		assert.match(rendered, /^┌─ ◆ Policy · Rules/m);
		for (const heading of ["origin", "slug", "state", "posture", "scope", "fires", "author model", "age"]) {
			assert.ok(rendered.includes(heading), heading);
		}
		assert.match(rendered, /agent\.no-force-push/);
		panel.handleInput(" ");
		assert.match(panel.render(140).join("\n"), /fires by model:/);
		for (const line of lines) assert.equal(visibleWidth(line), 140);
		assert.deepEqual(computePolicyPanes(136), { listWidth: 86, detailWidth: 47 });
	});

	it("shows the three collapsed groups and a first-rule hint when no agent rules exist", () => {
		const { panel } = rig(data({ agentRules: [] }));
		const rendered = panel.render(140).join("\n");
		assert.match(rendered, /No agent rules; press v, select activity, then d to draft one\./);
		for (const group of ["routing", "form", "bounds"]) assert.match(rendered, new RegExp(`▸ ${group}`));
		assert.doesNotMatch(rendered, /routing\.cat-read ·/);
	});

	it("expands and collapses a selected group in place with g", () => {
		const { panel } = rig(data({ agentRules: [] }));
		panel.handleInput("g");
		const expanded = panel.render(140).join("\n");
		assert.match(expanded, /routing\.cat-read · Use the read tool/);
		assert.match(expanded, /▾ routing · 7 rules · 3 fires/);
		panel.handleInput("g");
		assert.doesNotMatch(panel.render(140).join("\n"), /routing\.cat-read ·/);
	});

	it("refuses every built-in state key with the code-by-commit line", () => {
		for (const key of ["p", "m", "x", "a", "d"]) {
			const { panel, calls } = rig(data({ agentRules: [] }));
			panel.handleInput("g");
			panel.handleInput("\x1b[B");
			panel.handleInput(key);
			assert.match(panel.render(140).join("\n"), /Built-in rules are code and change by commit\./);
			assert.equal(calls.done, undefined);
		}
	});

	it("returns agent state actions to the host and keeps confirmation out of the component", () => {
		const promoted = rig();
		promoted.panel.handleInput("p");
		assert.deepEqual((promoted.calls.done as any).action, {
			kind: "state",
			slug: "no-force-push",
			state: "promoted",
		});

		const discarded = rig();
		discarded.panel.handleInput("d");
		assert.equal((discarded.calls.done as any).action.state, "discarded");
	});

	it("copies an agent rule as JSON in place and filters only in explicit filter mode", async () => {
		const { panel, calls } = rig();
		panel.handleInput("c");
		await flush();
		assert.deepEqual(calls.copied, ["no-force-push"]);
		assert.equal(calls.done, undefined);
		assert.match(panel.render(140).join("\n"), /Rule JSON copied\./);

		const filtered = rig();
		filtered.panel.handleInput("/");
		for (const char of "cat-read") filtered.panel.handleInput(char);
		assert.match(filtered.panel.render(140).join("\n"), /filter cat-read▌/);
		filtered.panel.handleInput("\x1b");
		assert.equal(filtered.calls.done, undefined);
		filtered.panel.handleInput("\x1b");
		assert.equal((filtered.calls.done as any).filter, "cat-read");
	});

	it("toggles to newest-first Activity rows and returns the draft action", () => {
		const records = [activity(), activity({ at: "2026-09-03T11:00:00.000Z", captured: "cat older.md" })];
		const { panel, calls } = rig(data({ activity: { ...data().activity, records } }));
		panel.handleInput("v");
		const rendered = panel.render(140).join("\n");
		for (const heading of ["time", "model", "rule ids", "blocked", "redacted command"]) {
			assert.ok(rendered.includes(heading), heading);
		}
		assert.match(rendered, /git push --force \[REDACTED\]/);
		panel.handleInput("d");
		assert.equal((calls.done as any).action.kind, "draft");
		assert.equal((calls.done as any).action.record.captured, "git push --force [REDACTED]");
	});

	it("accepts Kitty printable keys, stays width-bounded, and neutralizes terminal controls", () => {
		const hostile = data({
			agentRules: [agent({ note: "bad\x1b]0;title\x07" })],
			activity: { ...data().activity, records: [activity({ captured: "echo \x1b[31mred" })] },
		});
		const { panel } = rig(hostile, 9);
		panel.handleInput("\x1b[118u");
		const lines = panel.render(60);
		assert.match(lines.join("\n"), /Activity/);
		assert.ok(!lines.join("\n").includes("\x1b"));
		for (const line of lines) assert.equal(visibleWidth(line), 60);
		assert.equal(terminalSafe("x\x1by"), "x\\x1by");
	});
});

describe("bounded activity loading", () => {
	it("reads newest daily tails, keeps only matched records, and sorts by timestamp", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-activity-"));
		const old = recordLine(activity({ at: "2026-09-01T08:00:00.000Z", captured: "cat old.md" }));
		const unmatched = recordLine(activity({ at: "2026-09-03T13:00:00.000Z", classes: [] }));
		const latest = recordLine(activity({ at: "2026-09-03T12:00:00.000Z", captured: "cat latest.md" }));
		const middle = recordLine(activity({ at: "2026-09-03T11:00:00.000Z", captured: "cat middle.md" }));
		await writeFile(join(dir, "2026-09-01.jsonl"), old);
		await writeFile(join(dir, "2026-09-03.jsonl"), `${middle}${unmatched}${latest}`);
		await writeFile(join(dir, "other.jsonl"), recordLine(activity({ captured: "ignored" })));

		const result = await readRecentActivity(dir);
		assert.deepEqual(
			result.records.map((record) => record.captured),
			["cat latest.md", "cat middle.md", "cat old.md"],
		);
		assert.equal(result.partial, false);
	});

	it("enforces both the byte-tail bound and record bound with partial markers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-activity-"));
		const older = recordLine(activity({ at: "2026-09-02T12:00:00.000Z", captured: "cat old.md" }));
		const latest = recordLine(activity({ at: "2026-09-03T12:00:00.000Z", captured: "cat latest.md" }));
		await writeFile(join(dir, "2026-09-02.jsonl"), older);
		await writeFile(join(dir, "2026-09-03.jsonl"), latest);
		const byteLimited = await readRecentActivity(dir, Buffer.byteLength(latest), MAX_ACTIVITY_RECORDS);
		assert.deepEqual(
			byteLimited.records.map((record) => record.captured),
			["cat latest.md"],
		);
		assert.equal(byteLimited.byteLimited, true);
		assert.equal(byteLimited.partial, true);
		assert.equal(byteLimited.bytesRead, Buffer.byteLength(latest));

		const many = Array.from({ length: 4 }, (_, index) =>
			recordLine(activity({ at: `2026-09-03T12:00:0${index}.000Z`, captured: `cat ${index}.md` })),
		).join("");
		await writeFile(join(dir, "2026-09-03.jsonl"), many);
		const recordLimited = await readRecentActivity(dir, 1024 * 1024, 2);
		assert.equal(recordLimited.records.length, 2);
		assert.equal(recordLimited.recordLimited, true);
		assert.equal(recordLimited.partial, true);
	});
});

describe("activity draft message", () => {
	it("contains only the stored redacted command and asks for policy_rule_add", () => {
		const message = draftRuleMessage(activity({ captured: "curl -H 'Authorization: [REDACTED]' endpoint" }));
		assert.match(message, /Author a focused shell policy rule/);
		assert.match(message, /policy_rule_add/);
		assert.match(message, /Redacted command \(JSON string\): "curl -H/);
		assert.match(message, /\[REDACTED\]/);
		assert.doesNotMatch(message, /secret-token/);
	});
});
