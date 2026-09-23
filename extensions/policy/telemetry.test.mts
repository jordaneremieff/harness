import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, localDate } from "./store.ts";
import { formatTelemetry, readTelemetry, TELEMETRY_LIMITS } from "./telemetry.ts";

const DAY = "2026-09-03";
function fixture(overrides: Partial<PolicyRecord> = {}): PolicyRecord {
	return {
		at: "2026-09-03T12:00:00.000Z",
		tool: "read",
		callId: "private-call",
		session: "private-session",
		cwd: "/private/workspace",
		model: "private-provider/private-model",
		thinkingLevel: "high",
		mode: "tui",
		projectContext: true,
		ruleStoreDegraded: false,
		durationMs: 5,
		outputBytes: 100,
		tokens: null,
		policyMode: "enforce",
		classes: [],
		truncated: false,
		error: false,
		errorKind: null,
		outcome: "success",
		observationComplete: true,
		captured: "private-command-sentinel",
		policy: { decision: "none", evaluations: [], coverage: { evaluations: { total: 0, omitted: 0 } } },
		...overrides,
	};
}
function evalRow(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		revision: "123456789abc",
		phase: "input",
		applicable: true,
		truth: true,
		action: "deny",
		unavailable: false,
		deny: true,
		...overrides,
	};
}
function policy(evaluations: unknown[], decision = "deny", omitted = 0) {
	return { decision, evaluations, coverage: { evaluations: { total: evaluations.length + omitted, omitted } } };
}
async function directory(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "policy-telemetry-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function records(dir: string, values: unknown[], day = DAY): Promise<void> {
	await writeFile(join(dir, `${day}.jsonl`), values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}

function accounting(summary: Awaited<ReturnType<typeof readTelemetry>>): void {
	assert.equal(
		Object.values(summary.outcomes).reduce((a, b) => a + b, 0),
		summary.records,
	);
	assert.equal(
		Object.values(summary.observations).reduce((a, b) => a + b, 0),
		summary.records,
	);
	assert.equal(
		summary.errors.total,
		summary.errors.timeout + summary.errors.aborted + summary.errors.other + summary.errors.unavailable,
	);
	assert.equal(summary.denials.confirmed, summary.denials.withRuleAttribution + summary.denials.withoutRuleAttribution);
	assert.equal(
		summary.coverage.completeLines,
		summary.records + summary.coverage.malformedLines + summary.coverage.oversizedLines,
	);
	const tools = [...summary.tools, summary.otherTools];
	assert.equal(
		tools.reduce((n, row) => n + row.records, 0),
		summary.records,
	);
	assert.equal(
		tools.reduce((n, row) => n + row.errors, 0),
		summary.errors.total,
	);
	assert.equal(
		tools.reduce((n, row) => n + row.truncated, 0),
		summary.truncated,
	);
	assert.equal(
		tools.reduce((n, row) => n + row.denied, 0),
		summary.denials.confirmed,
	);
	const rules = [...summary.rules, summary.otherRules];
	assert.equal(
		rules.reduce((n, row) => n + row.evaluations, 0),
		summary.evaluations.retained,
	);
	assert.equal(
		rules.reduce((n, row) => n + row.matchedCalls, 0),
		summary.matches.retained,
	);
	assert.equal(
		rules.reduce((n, row) => n + row.deniedCalls, 0),
		summary.denials.ruleAttributionLinks,
	);
	for (const row of rules)
		assert.equal(row.evaluations, row.trueEvaluations + row.falseEvaluations + row.unknownEvaluations);
}

describe("policy telemetry aggregation", () => {
	it("separates confirmed outcomes, deny evaluations, and matches with exact tallies", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({
				classes: ["matched.only", "matched.only"],
				policy: policy([evalRow("observe.only")], "none"),
				policyMode: "observe",
			}),
			fixture({
				outcome: "denied",
				error: true,
				errorKind: "other",
				blocked: true,
				classes: ["first.rule", "matched.only"],
				policy: policy([
					evalRow("first.rule"),
					evalRow("first.rule"),
					evalRow("second.rule", { truth: "unknown", unavailable: true }),
				]),
			}),
			fixture({
				outcome: "denied",
				error: true,
				errorKind: "other",
				policy: policy([evalRow("external.rule")], "none"),
			}),
			fixture({ outcome: "execution-error", tool: "bash", error: true, errorKind: "timeout", truncated: true }),
			fixture({ outcome: "aborted", error: true, errorKind: "aborted" }),
			fixture({ outcome: "invalid", error: true, errorKind: "other" }),
			fixture({ outcome: "unexecuted", observationComplete: false }),
			fixture({ outcome: "incomplete", observationComplete: false }),
			fixture({
				blocked: true,
				policy: policy([evalRow("not.denied", { truth: false, applicable: false, deny: false })]),
			}),
		]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 9);
		assert.equal(result.coverage.status, "partial");
		assert.deepEqual(result.denials, {
			confirmed: 2,
			policyConfirmed: 1,
			withRuleAttribution: 1,
			withoutRuleAttribution: 1,
			ruleAttributionLinks: 2,
		});
		assert.deepEqual(result.errors, { total: 5, timeout: 1, aborted: 1, other: 3, unavailable: 0 });
		assert.equal(result.truncated, 1);
		assert.equal(result.outputBytes, 900);
		assert.equal(result.rules.find((row) => row.id === "matched.only")?.matchedCalls, 2);
		assert.equal(result.rules.find((row) => row.id === "matched.only")?.deniedCalls, 0);
		assert.equal(result.rules.find((row) => row.id === "first.rule")?.deniedCalls, 1);
		assert.equal(result.rules.find((row) => row.id === "first.rule")?.denialEvaluations, 2);
		assert.equal(result.rules.find((row) => row.id === "second.rule")?.deniedCalls, 1);
		assert.equal(result.rules.find((row) => row.id === "observe.only")?.deniedCalls, 0);
		assert.equal(result.rules.find((row) => row.id === "not.denied")?.inapplicableEvaluations, 1);
		accounting(result);
	});

	it("does not infer denial attribution from blocked, matches, mode, result phases, or unavailable applicability", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({ outcome: "denied", classes: ["just.match"], policy: policy([]) }),
			fixture({ outcome: "denied", policy: policy([evalRow("result.rule", { phase: "result" })]) }),
			fixture({ outcome: "denied", policy: policy([evalRow("unknown.rule", { applicable: "unknown" })]) }),
			fixture({ outcome: "denied", policyMode: "notice", policy: policy([evalRow("notice.rule")]) }),
			fixture({ outcome: undefined, blocked: true, policy: policy([evalRow("blocked.only")]) }),
		]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.denials.confirmed, 4);
		assert.equal(result.denials.withRuleAttribution, 0);
		assert.equal(result.denials.withoutRuleAttribution, 4);
		assert.equal(result.outcomes.unavailable, 1);
		accounting(result);
	});

	it("uses writer-local filenames without UTC filtering and matches appendRecord", async (t) => {
		const dir = await directory(t);
		const at = new Date(2026, 8, 3, 0, 1);
		assert.equal(await appendRecord(dir, fixture({ at: at.toISOString() })), null);
		assert.equal((await readTelemetry(dir, localDate(at), localDate(at))).records, 1);
		await records(dir, [fixture({ at: "2026-09-04T02:00:00.000Z" })]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 1);
		assert.equal(result.calendar, "writer-local-day-files");
		assert.equal(result.coverage.status, "complete");
	});

	it("exposes missing fields and evaluation coverage without losing valid tool volume", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({ policy: undefined, outcome: undefined, observationComplete: undefined, error: true, errorKind: null }),
			fixture({
				policy: { evaluations: [evalRow("known.rule"), {}], coverage: { evaluations: { total: 5, omitted: 1 } } },
			}),
			fixture({ policy: policy([evalRow("kept.rule")], "none", 7) }),
		]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 3);
		assert.equal(result.evaluations.recordsUnavailable, 1);
		assert.equal(result.evaluations.recordsWithUnknownCoverage, 1);
		assert.equal(result.evaluations.malformed, 1);
		assert.equal(result.evaluations.writerOmitted, 7);
		assert.equal(result.evaluations.retained, 2);
		assert.equal(result.errors.unavailable, 1);
		assert.equal(result.coverage.status, "partial");
		accounting(result);
	});

	it("bounds rule and tool groups while retaining overflow totals", async (t) => {
		const dir = await directory(t);
		await records(
			dir,
			Array.from({ length: TELEMETRY_LIMITS.groups + 9 }, (_, index) =>
				fixture({
					tool: `tool${index}`,
					outcome: "denied",
					classes: [`rule${index}`],
					policy: policy([evalRow(`rule${index}`)]),
				}),
			),
		);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.tools.length, TELEMETRY_LIMITS.groups);
		assert.equal(result.rules.length, TELEMETRY_LIMITS.groups);
		assert.equal(result.otherTools.records, 9);
		assert.equal(result.otherRules.deniedCalls, 9);
		assert.equal(result.otherRules.matchedCalls, 9);
		accounting(result);
	});

	it("bounds per-record arrays and accounts separately for omitted and invalid entries", async (t) => {
		const dir = await directory(t);
		const evaluations = Array.from({ length: TELEMETRY_LIMITS.entriesPerRecord + 8 }, () => evalRow("same.rule"));
		evaluations[0] = evalRow("bad rule");
		const classes = Array.from({ length: TELEMETRY_LIMITS.entriesPerRecord + 3 }, () => "same.rule");
		classes[0] = "bad rule";
		await records(dir, [fixture({ policy: policy(evaluations, "none"), classes })]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.evaluations.readerOmitted, 8);
		assert.equal(result.evaluations.malformed, 1);
		assert.equal(result.evaluations.retained, TELEMETRY_LIMITS.entriesPerRecord - 1);
		assert.equal(result.matches.readerOmitted, 3);
		assert.equal(result.matches.malformed, 1);
		assert.equal(result.matches.retained, 1);
		assert.equal(result.coverage.status, "partial");
		accounting(result);
	});

	it("never reports inexact byte or omission sums as exact counts", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({ outputBytes: Number.MAX_SAFE_INTEGER, policy: policy([], "none", Number.MAX_SAFE_INTEGER) }),
			fixture({ outputBytes: 1, policy: policy([], "none", 1) }),
		]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.outputBytes, null);
		assert.equal(result.tools[0].outputBytes, null);
		assert.equal(result.evaluations.writerOmitted, null);
		assert.match(formatTelemetry(result), /integer overflow/);
	});
});

describe("policy telemetry input and filesystem bounds", () => {
	it("rejects invalid dates, unordered ranges, excessive ranges, and invalid paths", async () => {
		for (const [from, to] of [
			["2026-9-03", DAY],
			["2026-02-30", "2026-03-01"],
			[DAY, "2026-09-02"],
			["2026-01-01", "2026-02-01"],
			["../private", DAY],
			["2026-13-01", DAY],
			["2026-09-00", DAY],
		]) {
			await assert.rejects(readTelemetry("/unused", from, to), RangeError);
		}
		for (const dir of ["", "x".repeat(4097), "a\0b"]) await assert.rejects(readTelemetry(dir, DAY, DAY), RangeError);
	});

	it("accepts leap days, month boundaries, and the maximum inclusive range", async (t) => {
		const dir = await directory(t);
		await records(dir, [], "2024-02-29");
		assert.equal((await readTelemetry(dir, "2024-02-29", "2024-02-29")).coverage.status, "complete");
		assert.equal((await readTelemetry(dir, "2026-08-30", "2026-09-02")).coverage.days.length, 4);
		assert.equal((await readTelemetry(dir, "2026-01-01", "2026-01-31")).coverage.days.length, TELEMETRY_LIMITS.days);
	});

	it("distinguishes empty files, absent day files, and absent directories without writes", async (t) => {
		const dir = await directory(t);
		await records(dir, []);
		const empty = await readTelemetry(dir, DAY, DAY);
		assert.equal(empty.coverage.status, "complete");
		assert.equal(empty.records, 0);
		const missingDay = await readTelemetry(dir, "2026-09-04", "2026-09-04");
		assert.equal(missingDay.coverage.status, "unavailable");
		assert.equal(missingDay.coverage.days[0].status, "missing");
		assert.equal((await readTelemetry(dir, DAY, "2026-09-04")).coverage.status, "partial");
		const path = join(dir, "absent");
		const missingDir = await readTelemetry(path, DAY, DAY);
		assert.equal(missingDir.coverage.directory, "missing");
		assert.equal(missingDir.coverage.status, "unavailable");
		await assert.rejects(lstat(path), { code: "ENOENT" });
	});

	it("rejects nonregular and symlink source directories and day files", async (t) => {
		const dir = await directory(t);
		const target = join(dir, "target");
		await mkdir(target);
		await records(target, [fixture()]);
		const linked = join(dir, "linked");
		await symlink(target, linked);
		assert.equal((await readTelemetry(linked, DAY, DAY)).coverage.directory, "symlink");
		assert.equal((await readTelemetry(join(target, `${DAY}.jsonl`), DAY, DAY)).coverage.directory, "nonregular");
		await symlink(join(target, `${DAY}.jsonl`), join(dir, `${DAY}.jsonl`));
		let result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 0);
		assert.deepEqual(result.coverage.days[0].issues, ["symlink"]);
		await mkdir(join(dir, "2026-09-04.jsonl"));
		result = await readTelemetry(dir, "2026-09-04", "2026-09-04");
		assert.deepEqual(result.coverage.days[0].issues, ["nonregular"]);
	});

	it("rejects a pipe without waiting for a writer", {
		skip: process.platform === "win32",
		timeout: 3000,
	}, async (t) => {
		const dir = await directory(t);
		execFileSync("mkfifo", [join(dir, `${DAY}.jsonl`)]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.coverage.days[0].status, "unavailable");
		assert.deepEqual(result.coverage.days[0].issues, ["nonregular"]);
	});

	it("reports unreadable files without exposing the source error or contents", {
		skip: process.getuid?.() === 0,
	}, async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture()]);
		await chmod(join(dir, `${DAY}.jsonl`), 0);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.coverage.status, "unavailable");
		assert.deepEqual(result.coverage.days[0].issues, ["read-error"]);
		assert.doesNotMatch(formatTelemetry(result), /private-/);
	});

	it("counts malformed complete lines and skips the unterminated final line", async (t) => {
		const dir = await directory(t);
		await writeFile(
			join(dir, `${DAY}.jsonl`),
			[
				JSON.stringify(fixture()),
				"{private-malformed",
				"",
				"null",
				"[]",
				JSON.stringify(fixture({ outputBytes: -1 })),
				JSON.stringify({ tool: "read" }),
				JSON.stringify(fixture()),
			].join("\n"),
		);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 1);
		assert.equal(result.coverage.malformedLines, 6);
		assert.equal(result.coverage.incompleteLines, 1);
		assert.equal(result.coverage.completeLines, 7);
		assert.equal(result.coverage.status, "partial");
		accounting(result);
	});

	it("rejects malformed UTF-8 without replacement-character normalization", async (t) => {
		const dir = await directory(t);
		const encoded = Buffer.from(`${JSON.stringify(fixture())}\n`);
		const marker = encoded.indexOf("private-command-sentinel");
		encoded[marker] = 0xff;
		await writeFile(join(dir, `${DAY}.jsonl`), encoded);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 0);
		assert.equal(result.coverage.malformedLines, 1);
		accounting(result);
	});

	it("skips oversized lines and resumes at the next complete record", async (t) => {
		const dir = await directory(t);
		await writeFile(
			join(dir, `${DAY}.jsonl`),
			`${JSON.stringify(fixture({ captured: "x".repeat(TELEMETRY_LIMITS.lineBytes) }))}\n${JSON.stringify(fixture())}\n`,
		);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 1);
		assert.equal(result.coverage.oversizedLines, 1);
		accounting(result);
	});

	it("enforces per-file and total byte limits with explicit skipped days", async (t) => {
		const dir = await directory(t);
		const content = `${JSON.stringify(fixture())}\n${"x".repeat(TELEMETRY_LIMITS.fileBytes)}`;
		await writeFile(join(dir, `${DAY}.jsonl`), content);
		await writeFile(join(dir, "2026-09-04.jsonl"), content);
		await records(dir, [fixture()], "2026-09-05");
		const result = await readTelemetry(dir, DAY, "2026-09-05");
		assert.equal(result.coverage.bytesRead, TELEMETRY_LIMITS.bytes);
		assert.equal(result.records, 2);
		assert.equal(result.coverage.cutoffLines, 2);
		assert.equal(result.coverage.days[0].bytesRead, TELEMETRY_LIMITS.fileBytes);
		assert.ok(result.coverage.days[0].issues.includes("file-byte-limit"));
		assert.equal(result.coverage.days[2].status, "skipped");
		assert.deepEqual(result.coverage.days[2].issues, ["total-byte-limit"]);
		accounting(result);
	});

	it("enforces the complete-line budget independently of byte and valid-record counts", async (t) => {
		const dir = await directory(t);
		await writeFile(join(dir, `${DAY}.jsonl`), `${"\n".repeat(TELEMETRY_LIMITS.lines)}${JSON.stringify(fixture())}\n`);
		await records(dir, [fixture()], "2026-09-04");
		const result = await readTelemetry(dir, DAY, "2026-09-04");
		assert.equal(result.records, 0);
		assert.equal(result.coverage.completeLines, TELEMETRY_LIMITS.lines);
		assert.equal(result.coverage.malformedLines, TELEMETRY_LIMITS.lines);
		assert.ok(result.coverage.days[0].unprocessedBytes > 0);
		assert.ok(result.coverage.days[0].issues.includes("line-limit"));
		assert.equal(result.coverage.days[1].status, "skipped");
		assert.deepEqual(result.coverage.days[1].issues, ["line-limit"]);
		accounting(result);
	});
});

describe("policy telemetry text", () => {
	it("excludes payloads, identities, terminal controls, and raw malformed data", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({
				tool: "unsafe\u001b[31m\nprivate-tool",
				classes: ["private-rule\nbody"],
				policy: policy([evalRow("private-eval\nbody")]),
			}),
			fixture(),
		]);
		const result = await readTelemetry(dir, DAY, DAY);
		const text = formatTelemetry(result);
		assert.doesNotMatch(JSON.stringify(result), /private-|private\/|\[31m/);
		assert.doesNotMatch(text, /private-|private\/|\x1b/);
		assert.match(text.split("\n")[1], /tool records;.*confirmed denials;.*errors;.*truncated outputs/);
		assert.ok(text.indexOf("Tool volume") < text.indexOf("Evidence coverage"));
		assert.match(text, /Worker outcomes: unavailable/);
		assert.match(text, /Matches and denial evaluations do not prove enforcement/);
		assert.deepEqual(result.workerOutcomes, { status: "unavailable", reason: "not-recorded-by-policy" });
		assert.ok(Buffer.byteLength(text) < 24 * 1024);
	});

	it("caps formatted output and names omitted rows even at maximal bounded groups", async (t) => {
		const dir = await directory(t);
		const result = await readTelemetry(dir, "2026-09-01", "2026-10-01");
		await records(dir, [fixture({ policy: policy([evalRow("rule")]) })]);
		const template = await readTelemetry(dir, DAY, DAY);
		result.tools = Array.from({ length: TELEMETRY_LIMITS.groups }, (_, n) => ({
			...template.tools[0],
			name: `tool${n}${"x".repeat(74)}`,
			records: Number.MAX_SAFE_INTEGER,
			errors: Number.MAX_SAFE_INTEGER,
			denied: Number.MAX_SAFE_INTEGER,
			truncated: Number.MAX_SAFE_INTEGER,
			outputBytes: Number.MAX_SAFE_INTEGER,
		}));
		result.rules = Array.from({ length: TELEMETRY_LIMITS.groups }, (_, n) => ({
			...template.rules[0],
			id: `rule${n}${"x".repeat(74)}`,
			matchedCalls: Number.MAX_SAFE_INTEGER,
			evaluations: Number.MAX_SAFE_INTEGER,
			trueEvaluations: Number.MAX_SAFE_INTEGER,
			falseEvaluations: Number.MAX_SAFE_INTEGER,
			unknownEvaluations: Number.MAX_SAFE_INTEGER,
			inapplicableEvaluations: Number.MAX_SAFE_INTEGER,
			denialEvaluations: Number.MAX_SAFE_INTEGER,
			deniedCalls: Number.MAX_SAFE_INTEGER,
		}));
		const text = formatTelemetry(result);
		assert.ok(Buffer.byteLength(text) <= TELEMETRY_LIMITS.outputBytes);
		assert.match(text, /Output omits \d+ tool rows and [1-9]\d* rule rows/);
		assert.match(text, /unknown evaluation coverage/);
	});
});
