import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	filteredRecords,
	fireBreakdownLines,
	formatPolicyList,
	formatPolicyShow,
	MAX_ACTIVITY_RECORDS,
	type PolicyActivityRecord,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
} from "./panel.ts";
import { activity, data, scopeContext, snapshot } from "./view-fixture.mts";

function segmentPath(dir: string, day: string, ordinal = 1): string {
	mkdirSync(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
	return join(dir, "telemetry", `${day}.${String(ordinal).padStart(6, "0")}.jsonl`);
}

const recordLine = (record: PolicyActivityRecord) => `${JSON.stringify(record)}\n`;

describe("unified text surfaces", () => {
	it("shows provenance, matcher, effective fields, override audit, stale/availability, proposals, and health", () => {
		const text = formatPolicyList(data());
		assert.match(text, /routing\.cat-read.*source: package.*matcher: code/);
		assert.match(text, /local\.scan.*state: disabled.*effect: block/);
		assert.match(text, /override reason: Temporarily noisy/);
		assert.match(text, /override audit: command/);
		assert.match(text, /stale override: yes.*available: yes/);
		assert.match(text, /PENDING PROPOSALS/);
		assert.match(text, /registry health: degraded=false \| ok/);
	});

	it("show includes full audit and scope visibility without origin-based collision status", () => {
		const collisionData = data({
			snapshot: snapshot({
				health: {
					status: "ok",
					path: "/agent/policy/rules.jsonl",
				},
			}),
		});
		const text = formatPolicyShow(collisionData, "local.scan", scopeContext) ?? "";
		assert.match(text, /registry health: degraded=false \| ok/);
		assert.match(text, /definition revision: 222222222222/);
		assert.match(text, /scope matches this session: yes/);
		assert.doesNotMatch(text, /catalog collision/);
		assert.match(text, /override reason: Temporarily noisy/);
		assert.match(text, /override audit:[\s\S]*session: session-local/);
		assert.match(text, /stale override: yes/);
	});

	it("show accepts a proposal id and reports degraded health in list", () => {
		assert.match(
			formatPolicyShow(data(), "00000000-0000-4000-8000-000000000009", scopeContext) ?? "",
			/operation: disable/,
		);
		const degraded = data({
			snapshot: snapshot({
				health: { status: "degraded", path: "/tmp/rules.jsonl", line: 2, message: "repair line 2", repair: "repair" },
			}),
		});
		assert.match(formatPolicyList(degraded), /degraded=true \| repair line 2/);
	});

	it("filters across source, matcher, effect, state, note, and override reason", () => {
		assert.deepEqual(
			filteredRecords(snapshot(), "package").map((record) => record.id),
			["routing.cat-read"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "declarative").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "block").map((record) => record.id),
			["routing.cat-read", "local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "disabled").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "bound scan output").map((record) => record.id),
			["local.scan"],
		);
		assert.deepEqual(
			filteredRecords(snapshot(), "temporarily noisy").map((record) => record.id),
			["local.scan"],
		);
	});

	it("sorts fire model details and escapes terminal controls", () => {
		assert.deepEqual(fireBreakdownLines(data().fireSummary, "routing.cat-read"), [
			"  openai-codex/gpt-5.6-sol: 2",
			"  (no model): 1",
		]);
		assert.equal(terminalSafe("ok\u001b[31m\u0000"), "ok\\x1b[31m\\x00");
	});
});

describe("bounded telemetry readers", () => {
	it("counts every unified id by model and marks a byte-bounded prefix partial", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		await writeFile(
			segmentPath(dir, "2026-09-03"),
			[
				recordLine(activity({ classes: ["routing.cat-read"], model: "p/a" })),
				recordLine(activity({ classes: ["routing.cat-read", "local.scan"], model: null })),
			].join(""),
		);
		const full = await readFireSummary(dir);
		assert.equal(full.fires.get("routing.cat-read"), 2);
		assert.equal(full.fires.get("local.scan"), 1);
		assert.equal(full.firesByModel.get("routing.cat-read")?.get(null), 1);
		assert.equal(full.partial, false);
		assert.equal((await readFireSummary(dir, 10)).partial, true);
	});

	it("reads newest matched activity, defaults old degraded telemetry false, and enforces the record bound", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		const old = { ...activity({ at: "2026-09-01T00:00:00.000Z" }) } as Record<string, unknown>;
		delete old.ruleStoreDegraded;
		await writeFile(segmentPath(dir, "2026-09-01"), `${JSON.stringify(old)}\n`);
		await writeFile(
			segmentPath(dir, "2026-09-02"),
			Array.from({ length: MAX_ACTIVITY_RECORDS + 2 }, (_, index) =>
				recordLine(
					activity({ at: `2026-09-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`, session: `s-${index}` }),
				),
			).join(""),
		);
		const result = await readRecentActivity(dir);
		assert.equal(result.records.length, MAX_ACTIVITY_RECORDS);
		assert.equal(result.recordLimited, true);
		assert.equal(result.partial, true);
		const onlyOld = await readRecentActivity(dir, 10_000_000, MAX_ACTIVITY_RECORDS + 10);
		assert.equal(onlyOld.records.find((entry) => entry.session === "session-observed")?.ruleStoreDegraded, false);
	});

	it("retains separate original and effective evaluation evidence for one policy", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const evaluations = [
			{
				id: "local.admission",
				phase: "input",
				inputView: "original",
				applicable: true,
				truth: false,
				unavailable: false,
			},
			{
				id: "local.admission",
				phase: "input",
				inputView: "effective",
				applicable: "unknown",
				truth: "unknown",
				unavailable: true,
			},
		];
		await writeFile(segmentPath(dir, "2026-01-01"), recordLine(activity({ policy: { evaluations } })));
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.evaluations, evaluations);
	});

	it("retains bounded reason codes but rejects arbitrary text and oversized reason arrays", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const valid = ["cli.unknown-option", "shell.dynamic-word"];
		const invalid = [
			["private command text"],
			["line\nfeed"],
			["X"],
			["x".repeat(81)],
			Array(17).fill("x"),
			[null],
			[""],
			"x",
		];
		await writeFile(
			segmentPath(dir, "2026-01-01"),
			recordLine(
				activity({
					policy: {
						evaluations: [valid, ...invalid].map((unavailableReasons) => ({ id: "sample", unavailableReasons })),
					},
				}),
			),
		);
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.evaluations, [
			{ id: "sample", unavailableReasons: valid },
			...invalid.map(() => ({ id: "sample" })),
		]);
	});

	it("retains data snapshot identity and omission evidence without data payloads", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const metadata = { name: "rooms", revision: "123456abcdef", status: "ready", snapshotAt: 1 };
		await writeFile(
			segmentPath(dir, "2026-01-01"),
			recordLine(
				activity({
					policy: {
						dataSnapshots: [{ ...metadata, rows: [{ key: "unretained-table-row", value: "private-value" }] }],
						coverage: { dataSnapshots: { total: 3, omitted: 2 } },
					},
				}),
			),
		);
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records[0].policy?.dataSnapshots, [metadata]);
		assert.deepEqual(result.records[0].policy?.recordedCoverage, { dataSnapshots: { total: 3, omitted: 2 } });
		assert.equal(JSON.stringify(result).includes("unretained-table-row"), false);
	});

	it("returns empty healthy results for a missing telemetry directory", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-panel-")), "missing");
		assert.deepEqual(await readRecentActivity(dir), {
			records: [],
			partial: false,
			byteLimited: false,
			recordLimited: false,
			bytesRead: 0,
		});
		assert.equal((await readFireSummary(dir)).partial, false);
	});
});

describe("telemetry directory boundary", () => {
	it("reads only the telemetry directory, across ordered segments of one day", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		await writeFile(join(dir, "2026-09-03.jsonl"), recordLine(activity({ classes: ["root.rule"] })));
		await writeFile(join(dir, "2026-09-03.000001.jsonl"), recordLine(activity({ classes: ["root.rule"] })));
		await writeFile(segmentPath(dir, "2026-09-03", 1), recordLine(activity({ classes: ["old.rule"], at: "2026-09-03T01:00:00.000Z" })));
		await writeFile(segmentPath(dir, "2026-09-03", 2), recordLine(activity({ classes: ["new.rule"], at: "2026-09-03T02:00:00.000Z" })));
		const fires = await readFireSummary(dir);
		assert.deepEqual([...fires.fires.keys()].sort(), ["new.rule", "old.rule"]);
		assert.equal(fires.partial, false);
		const result = await readRecentActivity(dir);
		assert.deepEqual(result.records.map((entry) => entry.classes[0]), ["new.rule", "old.rule"]);
		assert.equal(result.partial, false);
	});

	it("marks both readers partial when the inventory holds an unsafe entry, and still reads safe segments", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		await writeFile(segmentPath(dir, "2026-09-03"), recordLine(activity({ classes: ["safe.rule"] })));
		await symlink("/nonexistent", join(dir, "telemetry", "2026-09-02.000001.jsonl"));
		const fires = await readFireSummary(dir);
		assert.equal(fires.fires.get("safe.rule"), 1);
		assert.equal(fires.partial, true);
		const result = await readRecentActivity(dir);
		assert.equal(result.records.length, 1);
		assert.equal(result.partial, true);
	});

	it("reports an unreadable telemetry path as partial rather than empty", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "policy-panel-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		await writeFile(join(dir, "telemetry"), "not a directory");
		assert.equal((await readFireSummary(dir)).partial, true);
		assert.equal((await readRecentActivity(dir)).partial, true);
	});
});
