import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildRuleRows,
	computePolicyPanes,
	fireBreakdownLines,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	MAX_FIRE_SCAN_BYTES,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type BuiltinRuleInfo,
	type PolicyActivityRecord,
	type PolicyPanelData,
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

function activity(overrides: Partial<PolicyActivityRecord> = {}): PolicyActivityRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "high",
		tool: "bash",
		classes: ["routing.cat-read", "bounds.false-cap"],
		blocked: true,
		error: true,
		captured: "cat [REDACTED]",
		policyMode: "enforce",
		session: "session-observed",
		...overrides,
	};
}

function data(overrides: Partial<PolicyPanelData> = {}): PolicyPanelData {
	return {
		builtins,
		fireSummary: {
			fires: new Map([
				["routing.cat-read", 3],
				["form.grep-file", 2],
				["bounds.false-cap", 5],
			]),
			firesByModel: new Map([
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

function rig(panelData = data(), rows = 24) {
	const calls = { renders: 0, done: undefined as unknown };
	const panel = new PolicyPanel({
		data: panelData,
		theme,
		tui: { requestRender: () => calls.renders++ },
		getMaxRows: () => rows,
		done: (result) => {
			calls.done = result;
		},
	});
	return { panel, calls };
}

function recordLine(record: PolicyActivityRecord): string {
	return `${JSON.stringify(record)}\n`;
}

describe("built-in policy formatting", () => {
	it("shows exactly three collapsed built-in groups and expands members in place", () => {
		const collapsed = buildRuleRows(builtins, data().fireSummary.fires, new Set());
		assert.deepEqual(
			collapsed.map((row) => row.kind === "group" && row.group),
			["routing", "form", "bounds"],
		);
		const expanded = buildRuleRows(builtins, data().fireSummary.fires, new Set(["routing"]));
		assert.ok(expanded.some((row) => row.kind === "builtin" && row.rule.id === "routing.cat-read"));
	});

	it("prints built-in groups, full detail, and per-model fire evidence", () => {
		const listed = formatPolicyList(data());
		assert.match(listed, /^BUILT-IN GROUPS/m);
		const shown = formatPolicyShow(data(), "routing.cat-read") ?? "";
		assert.match(shown, /id: routing\.cat-read/);
		assert.match(shown, /openai-codex\/gpt-5\.6-sol: 2/);
		assert.match(shown, /\(no model\): 1/);
		assert.equal(formatPolicyShow(data(), "agent.retired"), undefined);
	});

	it("surfaces the fire-scan bound and keeps terminal output safe", () => {
		const partial = data({ fireSummary: { ...data().fireSummary, partial: true } });
		assert.match(formatPolicyList(partial), new RegExp(String(MAX_FIRE_SCAN_BYTES)));
		assert.equal(terminalSafe("bad\u001bvalue"), "bad\\x1bvalue");
		assert.deepEqual(fireBreakdownLines(data().fireSummary, "unknown"), ["  (none)"]);
		assert.deepEqual(computePolicyPanes(116), { listWidth: 74, detailWidth: 39 });
	});
});

describe("PolicyPanel", () => {
	it("renders only built-in controls and ignores retired authoring keys", () => {
		const { panel, calls } = rig();
		const lines = panel.render(116);
		assert.ok(lines.every((line) => visibleWidth(line) <= 116));
		assert.match(lines.join("\n"), /g group/);
		assert.doesNotMatch(lines.join("\n"), /draft|promote|demote|discard|copy/);
		panel.handleInput("d");
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b");
		assert.deepEqual(calls.done, {
			view: "rules",
			filter: "",
			expandedGroups: [],
			selectedRuleKey: "group:routing",
			selectedActivityKey: "2026-09-03T12:00:00.000Z\0session-observed\0bash\0routing.cat-read,bounds.false-cap\0cat [REDACTED]",
		});
	});

	it("toggles Rules and Activity and expands the selected group", () => {
		const { panel } = rig();
		panel.handleInput("g");
		assert.match(panel.render(116).join("\n"), /routing\.cat-read/);
		panel.handleInput("v");
		assert.match(panel.render(116).join("\n"), /cat \[REDACTED\]/);
	});
});

describe("bounded telemetry loading", () => {
	it("counts built-in fires and models through the daily store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-fires-"));
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			[
				recordLine(activity({ model: "model/a", classes: ["routing.cat-read"] })),
				recordLine(activity({ model: null, classes: ["routing.cat-read", "form.grep-file"] })),
			].join(""),
		);
		const summary = await readFireSummary(dir);
		assert.equal(summary.partial, false);
		assert.equal(summary.fires.get("routing.cat-read"), 2);
		assert.equal(summary.firesByModel.get("routing.cat-read")?.get("model/a"), 1);
		assert.equal(summary.firesByModel.get("routing.cat-read")?.get(null), 1);
		assert.equal((await readFireSummary(dir, 1)).partial, true);
	});

	it("reads newest daily tails and enforces byte and record bounds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-activity-"));
		await writeFile(
			join(dir, "2026-09-02.jsonl"),
			recordLine(activity({ at: "2026-09-02T10:00:00.000Z", session: "old" })),
		);
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			[
				recordLine(activity({ at: "2026-09-03T11:00:00.000Z", session: "middle" })),
				recordLine(activity({ at: "2026-09-03T12:00:00.000Z", session: "new" })),
			].join(""),
		);
		const loaded = await readRecentActivity(dir);
		assert.deepEqual(loaded.records.map((record) => record.session), ["new", "middle", "old"]);
		const recordLimited = await readRecentActivity(dir, 1_000_000, 1);
		assert.equal(recordLimited.recordLimited, true);
		assert.equal(recordLimited.records.length, 1);
		const byteLimited = await readRecentActivity(dir, 1, MAX_ACTIVITY_RECORDS);
		assert.equal(byteLimited.byteLimited, true);
	});
});
