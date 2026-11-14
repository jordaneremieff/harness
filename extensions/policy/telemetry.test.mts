import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord } from "./store.ts";
import { localDate, TELEMETRY_INVENTORY_ENTRIES } from "./telemetry-files.ts";
import { telemetryDecisionRows } from "./runtime.ts";
import {
	formatTelemetry,
	readTelemetry,
	readTelemetryPage,
	TELEMETRY_LIMITS,
	type TelemetryRequest,
	type TelemetrySummary,
	telemetryInstant,
} from "./telemetry.ts";

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
		policy: { decision: "none", evaluations: [], coverage: { evaluations: { total: 0, omitted: 0, irrelevant: 0 } } },
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
	return { decision, evaluations, coverage: { evaluations: { total: evaluations.length + omitted, omitted, irrelevant: 0 } } };
}
async function directory(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "policy-telemetry-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "telemetry"), { mode: 0o700 });
	return dir;
}
function segment(dir: string, day: string, ordinal = 1): string {
	return join(dir, "telemetry", `${day}.${String(ordinal).padStart(6, "0")}.jsonl`);
}
async function records(dir: string, values: unknown[], day = DAY, ordinal = 1): Promise<void> {
	await writeFile(segment(dir, day, ordinal), values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}
/** Follow every cursor of one selection; each page must stay within the page byte bound. */
async function allPages(dir: string, request: TelemetryRequest, limit = 16): Promise<TelemetrySummary[]> {
	const pages: TelemetrySummary[] = [];
	let cursor: string | null | undefined;
	do {
		const page = await readTelemetryPage(dir, cursor ? { ...request, cursor } : request);
		assert.ok(page.coverage.bytesRead <= TELEMETRY_LIMITS.bytes);
		pages.push(page);
		cursor = page.continuation.nextCursor;
	} while (cursor && pages.length < limit);
	assert.equal(cursor, null, "the selection is exhausted within the test bound");
	return pages;
}
const total = (pages: TelemetrySummary[], pick: (page: TelemetrySummary) => number) =>
	pages.reduce((sum, page) => sum + pick(page), 0);

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
		summary.records +
			summary.coverage.malformedLines +
			summary.coverage.oversizedLines +
			summary.coverage.outsideWindowLines,
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

describe("compact policy decision records", () => {
	it("bounds plain allows and retains full denial, unavailable, guidance and correction facts", async (t) => {
		const evaluations = Array.from({ length: 80 }, (_, index) => evalRow(`rule-${index}`, { truth: false, deny: false }));
		const pins = Array.from({ length: 36 }, (_, index) => ({ id: `rule-${index}`, revision: "123456789abc", generation: 1 }));
		const rows = telemetryDecisionRows(evaluations, pins, [], []);
		const before = Buffer.byteLength(JSON.stringify(fixture({ policy: { evaluations, generations: pins } })));
		const compact = fixture({ policy: {
			decision: "none",
			evaluations: rows.evaluations.rows, generations: rows.generations.rows,
			coverage: {
				evaluations: { total: rows.evaluations.total, omitted: rows.evaluations.omitted, irrelevant: rows.evaluations.irrelevant },
				generations: { total: rows.generations.total, omitted: rows.generations.omitted, irrelevant: rows.generations.irrelevant },
			},
		} });
		const after = Buffer.byteLength(JSON.stringify(compact));
		assert.ok(after < 1600, `allow record size ${after}`);
		assert.ok(after < before / 10);
		assert.equal(rows.evaluations.irrelevant, 80);
		assert.equal(rows.generations.irrelevant, 36);
		const dir = await directory(t);
		await records(dir, [compact]);
		const summary = await readTelemetry(dir, DAY, DAY);
		assert.equal(summary.coverage.status, "complete");
		assert.equal(summary.evaluations.irrelevant, 80);
		assert.equal(summary.evaluations.writerOmitted, 0);
		t.diagnostic(`Synthetic allow record: ${before} -> ${after} UTF-8 bytes (80 evaluations, 36 pins).`);
		const relevant = [
			evalRow("rule-0", { unavailable: true, truth: "unknown", unavailableReasons: ["input-unavailable"] }),
			evalRow("rule-1", { action: "guide", deny: false }),
			evalRow("rule-2", { action: "rename-key", deny: false }),
			evalRow("rule-3"),
		];
		const denial = telemetryDecisionRows([...evaluations.slice(4), ...relevant], pins, [], [{ id: "rule-2" }]);
		assert.deepEqual(denial.evaluations.rows, relevant);
		assert.deepEqual(denial.generations.rows, pins.slice(0, 4));
		assert.equal(denial.evaluations.omitted, 0);
	});
});

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
		await records(dir, [fixture({ at: "2026-09-04T02:00:00.000Z" })], "2026-09-04");
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
	it("keeps the newest records at a saturated line budget and continues to the older denial", async (t) => {
		const dir = await directory(t);
		await writeFile(segment(dir, DAY),
			`${JSON.stringify(fixture({ outcome: "denied", policy: policy([evalRow("deny-first")]) }))}\n${"null\n".repeat(TELEMETRY_LIMITS.lines)}${JSON.stringify(fixture({ tool: "newest" }))}\n`);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.denials.confirmed, 0);
		assert.equal(result.tools.find((row) => row.name === "newest")?.records, 1);
		assert.equal(result.coverage.completeLines, TELEMETRY_LIMITS.lines);
		assert.equal(result.coverage.order, "newest-first-contiguous");
		assert.ok(result.coverage.days[0].issues.includes("line-limit"));
		assert.ok(result.continuation.nextCursor);
		accounting(result);
		const next = await readTelemetryPage(dir, { from: DAY, to: DAY, cursor: result.continuation.nextCursor });
		assert.equal(next.continuation.page, "resumed");
		assert.equal(next.continuation.position, "resumed");
		assert.equal(next.denials.withRuleAttribution, 1);
		assert.equal(next.coverage.malformedLines, 1);
		assert.equal(next.continuation.nextCursor, null);
		assert.equal(next.coverage.days[0].segments[0].startOffset, 0);
		assert.equal(next.coverage.days[0].segments[0].endOffset, result.coverage.days[0].segments[0].startOffset);
		accounting(next);
	});

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

	it("rejects nonregular and symlink telemetry directories and segments", async (t) => {
		const dir = await directory(t);
		const target = join(dir, "target");
		await mkdir(target);
		await writeFile(join(target, "2026-09-03.000001.jsonl"), `${JSON.stringify(fixture())}\n`);
		const linkedPolicy = await mkdtemp(join(tmpdir(), "policy-telemetry-link-"));
		t.after(() => rm(linkedPolicy, { recursive: true, force: true }));
		await symlink(target, join(linkedPolicy, "telemetry"));
		assert.equal((await readTelemetry(linkedPolicy, DAY, DAY)).coverage.directory, "symlink");
		const filePolicy = await mkdtemp(join(tmpdir(), "policy-telemetry-file-"));
		t.after(() => rm(filePolicy, { recursive: true, force: true }));
		await writeFile(join(filePolicy, "telemetry"), "not a directory");
		assert.equal((await readTelemetry(filePolicy, DAY, DAY)).coverage.directory, "nonregular");
		await symlink(join(target, "2026-09-03.000001.jsonl"), segment(dir, DAY));
		let result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 0);
		assert.deepEqual(result.coverage.days[0].issues, ["symlink"]);
		assert.equal(result.coverage.inventory, "incomplete");
		await mkdir(segment(dir, "2026-09-04"));
		result = await readTelemetry(dir, "2026-09-04", "2026-09-04");
		assert.deepEqual(result.coverage.days[0].issues, ["nonregular"]);
	});

	it("reads ordered segments of one day newest first and ignores unrecognised names", async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture({ tool: "first" })], DAY);
		await writeFile(segment(dir, DAY, 2), `${JSON.stringify(fixture({ tool: "second" }))}\n`);
		await writeFile(join(dir, "telemetry", `${DAY}.jsonl`), `${JSON.stringify(fixture({ tool: "legacy" }))}\n`);
		await writeFile(join(dir, `${DAY}.jsonl`), `${JSON.stringify(fixture({ tool: "root" }))}\n`);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.deepEqual(result.tools.map((row) => row.name).sort(), ["first", "second"]);
		assert.deepEqual(result.coverage.days[0].segments.map((entry) => entry.ordinal), [2, 1]);
		assert.equal(result.coverage.status, "complete");
		const text = formatTelemetry(result);
		assert.doesNotMatch(text, /legacy|root/);
	});

	it("reports an inventory beyond the entry bound as incomplete", async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture()]);
		for (let index = 0; index < TELEMETRY_INVENTORY_ENTRIES; index++)
			await writeFile(join(dir, "telemetry", `extra-${index}`), "");
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.coverage.inventory, "incomplete");
		assert.equal(result.coverage.status, "partial");
	});

	it("rejects a pipe without waiting for a writer", {
		skip: process.platform === "win32",
		timeout: 3000,
	}, async (t) => {
		const dir = await directory(t);
		execFileSync("mkfifo", [segment(dir, DAY)]);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.coverage.days[0].status, "unavailable");
		assert.deepEqual(result.coverage.days[0].issues, ["nonregular"]);
	});

	it("reports unreadable files without exposing the source error or contents", {
		skip: process.getuid?.() === 0,
	}, async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture()]);
		await chmod(segment(dir, DAY), 0);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.coverage.status, "unavailable");
		assert.deepEqual(result.coverage.days[0].issues, ["read-error"]);
		assert.doesNotMatch(formatTelemetry(result), /private-/);
	});

	it("ignores separators, counts nonempty malformed lines and skips the unterminated final line", async (t) => {
		const dir = await directory(t);
		await writeFile(
			segment(dir, DAY),
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
		assert.equal(result.coverage.malformedLines, 5);
		assert.equal(result.coverage.incompleteLines, 1);
		assert.equal(result.coverage.completeLines, 6);
		assert.equal(result.coverage.status, "partial");
		accounting(result);
	});

	it("rejects malformed UTF-8 without replacement-character normalization", async (t) => {
		const dir = await directory(t);
		const encoded = Buffer.from(`${JSON.stringify(fixture())}\n`);
		const marker = encoded.indexOf("private-command-sentinel");
		encoded[marker] = 0xff;
		await writeFile(segment(dir, DAY), encoded);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 0);
		assert.equal(result.coverage.malformedLines, 1);
		accounting(result);
	});

	it("skips oversized lines and resumes at the next complete record", async (t) => {
		const dir = await directory(t);
		await writeFile(
			segment(dir, DAY),
			`${JSON.stringify(fixture({ captured: "x".repeat(TELEMETRY_LIMITS.lineBytes) }))}\n${JSON.stringify(fixture())}\n`,
		);
		const result = await readTelemetry(dir, DAY, DAY);
		assert.equal(result.records, 1);
		assert.equal(result.coverage.oversizedLines, 1);
		accounting(result);
	});

	it("stops a page at the byte bound and names the days it did not reach", async (t) => {
		const dir = await directory(t);
		const line = `${JSON.stringify(fixture({ captured: "p".repeat(200 * 1024) }))}\n`;
		await writeFile(segment(dir, "2026-09-05"), line.repeat(Math.ceil(TELEMETRY_LIMITS.bytes / line.length) + 4));
		await records(dir, [fixture({ outcome: "denied" })], "2026-09-04");
		await records(dir, [fixture()], DAY);
		const result = await readTelemetry(dir, DAY, "2026-09-05");
		assert.equal(result.coverage.bytesRead, TELEMETRY_LIMITS.bytes);
		assert.deepEqual(result.coverage.days.map((day) => day.day), ["2026-09-05", "2026-09-04", DAY]);
		assert.ok(result.coverage.days[0].issues.includes("total-byte-limit"));
		assert.ok((result.coverage.days[0].segments[0].startOffset ?? 0) > 0);
		assert.deepEqual(result.coverage.days.slice(1).map((day) => [day.status, day.segmentsNotReached]), [["skipped", 1], ["skipped", 1]]);
		assert.equal(result.coverage.status, "partial");
		assert.equal(result.coverage.pageStatus, "complete");
		assert.equal(result.denials.confirmed, 0);
		accounting(result);
	});

	it("enforces the complete-line budget independently of byte and valid-record counts", async (t) => {
		const dir = await directory(t);
		await writeFile(segment(dir, DAY), `${"null\n".repeat(TELEMETRY_LIMITS.lines)}${JSON.stringify(fixture())}\n`);
		await records(dir, [fixture()], "2026-09-04");
		const result = await readTelemetry(dir, DAY, "2026-09-04");
		assert.equal(result.records, 2);
		assert.equal(result.coverage.completeLines, TELEMETRY_LIMITS.lines);
		assert.equal(result.coverage.malformedLines, TELEMETRY_LIMITS.lines - 2);
		assert.ok((result.coverage.days[1].segments[0].bytesNotRead ?? 0) > 0);
		assert.ok(result.coverage.days[1].issues.includes("line-limit"));
		assert.equal(result.coverage.days[0].status, "complete");
		accounting(result);
	});
});

describe("policy telemetry continuation", () => {
	it("covers every record once across pages, earlier bytes, and older segments", async (t) => {
		const dir = await directory(t);
		const big = Array.from({ length: 60 }, (_, n) => fixture({ tool: `big${n % 3}`, captured: "p".repeat(200 * 1024) }));
		await records(dir, big, DAY, 1);
		await records(dir, [fixture({ tool: "second" }), fixture({ outcome: "denied" })], DAY, 2);
		await records(dir, [fixture({ tool: "older" })], "2026-09-02");
		const pages = await allPages(dir, { from: "2026-09-02", to: DAY });
		assert.ok(pages.length >= 2);
		assert.equal(total(pages, (page) => page.records), 63);
		assert.equal(total(pages, (page) => page.denials.confirmed), 1);
		assert.equal(total(pages, (page) => page.coverage.malformedLines + page.coverage.oversizedLines), 0);
		assert.deepEqual(pages.map((page) => page.continuation.page), ["first", ...pages.slice(1).map(() => "resumed")]);
		for (const page of pages) {
			assert.equal(page.coverage.pageStatus, "complete");
			accounting(page);
		}
		assert.deepEqual(pages.slice(0, -1).map((page) => page.coverage.status), pages.slice(0, -1).map(() => "partial"));
		assert.equal(pages.at(-1)?.coverage.status, "complete");
		assert.deepEqual(pages.at(-1)?.coverage.days.map((day) => day.status), ["complete", "complete"]);
		const covered = pages.flatMap((page) => page.coverage.days.flatMap((day) => day.segments.filter((row) => row.name.endsWith(".000001.jsonl") && row.name.startsWith(DAY))));
		assert.equal(covered[0].endOffset, covered[0].size);
		for (let index = 1; index < covered.length; index++) assert.equal(covered[index].endOffset, covered[index - 1].startOffset);
		assert.equal(covered.at(-1)?.startOffset, 0);
	});

	it("crosses one line longer than a page as a single oversized line", async (t) => {
		const dir = await directory(t);
		await writeFile(
			segment(dir, DAY),
			`${JSON.stringify(fixture({ tool: "before" }))}\n${"x".repeat(TELEMETRY_LIMITS.bytes + 1024 * 1024)}\n${JSON.stringify(fixture({ tool: "after" }))}\n`,
		);
		const pages = await allPages(dir, { from: DAY, to: DAY });
		assert.equal(pages.length, 3);
		assert.equal(total(pages, (page) => page.records), 2);
		assert.equal(total(pages, (page) => page.coverage.oversizedLines), 1);
		assert.deepEqual(pages.map((page) => page.tools.map((row) => row.name)), [["after"], [], ["before"]]);
	});

	it("reports a vanished or replaced cursor segment and continues with older segments", async (t) => {
		for (const change of ["vanished", "changed"] as const) {
			const dir = await directory(t);
			const line = `${JSON.stringify(fixture({ captured: "p".repeat(200 * 1024) }))}\n`;
			await writeFile(segment(dir, DAY, 2), line.repeat(Math.ceil(TELEMETRY_LIMITS.bytes / line.length) + 4));
			await records(dir, [fixture({ tool: "older" })], DAY, 1);
			const first = await readTelemetry(dir, DAY, DAY);
			assert.ok(first.continuation.nextCursor);
			if (change === "vanished") await unlink(segment(dir, DAY, 2));
			else {
				await writeFile(`${segment(dir, DAY, 2)}.new`, line.repeat(64));
				await rename(`${segment(dir, DAY, 2)}.new`, segment(dir, DAY, 2));
			}
			const next = await readTelemetryPage(dir, { from: DAY, to: DAY, cursor: first.continuation.nextCursor });
			assert.equal(next.continuation.position, change);
			assert.equal(next.continuation.olderSegments, "retained");
			const [lost, older] = next.coverage.days[0].segments;
			assert.equal(lost.status, change === "vanished" ? "missing" : "unavailable");
			assert.deepEqual(lost.issues, [change === "vanished" ? "missing" : "source-changed"]);
			assert.equal(lost.bytesNotRead, first.coverage.days[0].segments[0].startOffset);
			assert.equal(older.status, "complete");
			assert.deepEqual(next.tools.map((row) => row.name), ["older"]);
			assert.equal(next.coverage.pageStatus, "partial");
			assert.equal(next.continuation.nextCursor, null);
		}
	});

	it("reports retention removal of the oldest first-page segment", async (t) => {
		const dir = await directory(t);
		const line = `${JSON.stringify(fixture({ captured: "p".repeat(200 * 1024) }))}\n`;
		await writeFile(segment(dir, DAY, 2), line.repeat(Math.ceil(TELEMETRY_LIMITS.bytes / line.length) + 4));
		await records(dir, [fixture()], DAY, 1);
		const first = await readTelemetry(dir, DAY, DAY);
		await unlink(segment(dir, DAY, 1));
		const next = await readTelemetryPage(dir, { from: DAY, to: DAY, cursor: first.continuation.nextCursor ?? "" });
		assert.equal(next.continuation.position, "resumed");
		assert.equal(next.continuation.olderSegments, "removed");
		assert.equal(next.coverage.pageStatus, "partial");
		assert.match(formatTelemetry(next), /oldest first-page segment removed/);
	});

	it("binds a cursor to its selection and directory and refuses malformed cursors", async (t) => {
		const dir = await directory(t);
		const line = `${JSON.stringify(fixture({ captured: "p".repeat(200 * 1024) }))}\n`;
		await writeFile(segment(dir, DAY), line.repeat(Math.ceil(TELEMETRY_LIMITS.bytes / line.length) + 4));
		const cursor = (await readTelemetry(dir, DAY, DAY)).continuation.nextCursor ?? "";
		const other = await directory(t);
		for (const [path, request] of [
			[dir, { from: "2026-09-02", to: DAY, cursor }],
			[other, { from: DAY, to: DAY, cursor }],
			[dir, { since: "2026-09-03T00:00:00Z", until: "2026-09-04T00:00:00Z", cursor }],
		] as const)
			await assert.rejects(readTelemetryPage(path, request), /another selection/);
		for (const bad of ["", "!", "x".repeat(TELEMETRY_LIMITS.cursorChars + 1), Buffer.from("{\"v\":2}").toString("base64url")])
			await assert.rejects(readTelemetryPage(dir, { from: DAY, to: DAY, cursor: bad }), /malformed/);
	});
});

describe("policy telemetry instants", () => {
	it("matches recorded instants in a half-open interval across covering writer-local day files", async (t) => {
		const dir = await directory(t);
		await records(dir, [
			fixture({ tool: "early", at: "2026-09-02T22:59:59.999Z" }),
			fixture({ tool: "inside", at: "2026-09-02T23:00:00.000Z" }),
		], "2026-09-03");
		await records(dir, [fixture({ tool: "inside", at: "2026-09-03T00:30:00.000Z" }), fixture({ tool: "end", at: "2026-09-03T01:00:00.000Z" })], "2026-09-02");
		await records(dir, [fixture({ tool: "inside", at: "2026-09-03T00:59:00.000Z" })], "2026-09-01");
		const result = await readTelemetryPage(dir, { since: "2026-09-03T10:00:00+11:00", until: "2026-09-03T12:00:00+11:00" });
		assert.deepEqual(result.selection, {
			kind: "instants",
			since: "2026-09-03T10:00:00+11:00",
			until: "2026-09-03T12:00:00+11:00",
			sinceUtc: "2026-09-02T23:00:00.000Z",
			untilUtc: "2026-09-03T01:00:00.000Z",
			end: "exclusive",
			dayFiles: { from: "2026-09-02", to: "2026-09-03", offsets: "utc-12:00-to-utc+14:00" },
			segmentsModifiedBeforeSince: "excluded",
		});
		assert.deepEqual([result.from, result.to], ["2026-09-02", "2026-09-03"]);
		assert.deepEqual(result.tools.map((row) => [row.name, row.records]), [["inside", 2]]);
		assert.equal(result.coverage.outsideWindowLines, 2);
		assert.equal(result.coverage.status, "complete");
		accounting(result);
		const wide = await readTelemetryPage(dir, { since: "2026-09-02T23:00:00Z", until: "2026-09-05T00:00:00Z" });
		assert.equal(wide.coverage.days.find((day) => day.day === "2026-09-05")?.status, "missing");
		assert.equal(wide.coverage.status, "complete", "an absent covering day file is not a gap");
		assert.match(formatTelemetry(result), /recorded instants from 2026-09-02T23:00:00.000Z up to 2026-09-03T01:00:00.000Z \(exclusive/);
	});

	it("excludes segments last modified before the start instant without reading them", async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture({ at: "2026-09-03T01:00:00.000Z" })], DAY, 1);
		await records(dir, [fixture({ tool: "later", at: "2026-09-03T05:00:00.000Z" })], DAY, 2);
		const old = new Date("2026-09-03T02:00:00.000Z");
		await utimes(segment(dir, DAY, 1), old, old);
		const result = await readTelemetryPage(dir, { since: "2026-09-03T04:00:00Z", until: "2026-09-03T06:00:00Z" });
		const [newer, excluded] = result.coverage.days.find((day) => day.day === DAY)?.segments ?? [];
		assert.equal(newer.status, "complete");
		assert.deepEqual([excluded.status, excluded.bytesRead, excluded.issues], ["excluded", 0, []]);
		assert.deepEqual(result.tools.map((row) => row.name), ["later"]);
		assert.equal(result.coverage.status, "complete");
	});

	it("requires explicit zones, valid calendar times, one selection, and a bounded ordered interval", async () => {
		assert.equal(telemetryInstant("2026-09-03T10:00:00.5-03:30"), Date.parse("2026-09-03T13:30:00.500Z"));
		for (const [since, until] of [
			["2026-09-03T10:00:00", "2026-09-03T11:00:00Z"],
			["2026-02-30T10:00:00Z", "2026-03-01T00:00:00Z"],
			["2026-09-03T24:00:00Z", "2026-09-04T01:00:00Z"],
			["2026-09-03T10:00:00+14:30", "2026-09-04T01:00:00Z"],
			["2026-09-03T10:00:00Z", "2026-09-03T10:00:00Z"],
			["2026-09-03T10:00:00Z", "2026-10-03T10:00:00Z"],
		])
			await assert.rejects(readTelemetryPage("/unused", { since, until }), RangeError);
		await assert.rejects(
			readTelemetryPage("/unused", { from: DAY, to: DAY, since: "2026-09-03T10:00:00Z", until: "2026-09-03T11:00:00Z" } as TelemetryRequest),
			/exactly one selection/,
		);
	});
});

describe("policy telemetry recording evidence", () => {
	it("joins this writer's health with its scope and never claims complete recording", async (t) => {
		const dir = await directory(t);
		await records(dir, [fixture()]);
		const none = await readTelemetry(dir, DAY, DAY);
		assert.deepEqual(none.recording, { status: "unknown", writer: { scope: "unavailable" }, otherWriters: "unknown" });
		const clean = await readTelemetry(dir, DAY, DAY, { health: { state: "ok", lostRecords: 0, lostBytes: 0 } });
		assert.deepEqual(clean.recording, {
			status: "unknown",
			writer: { scope: "this-process-since-start", health: { state: "ok", lostRecords: 0, lostBytes: 0 } },
			otherWriters: "unknown",
		});
		assert.equal(clean.coverage.status, "complete");
		const lossy = await readTelemetry(dir, DAY, DAY, { health: { state: "pressure", lostRecords: 2, lostBytes: 900, reason: "lock busy" } });
		assert.equal(lossy.recording.status, "incomplete");
		assert.match(formatTelemetry(lossy), /Recording: incomplete\. This process's writer since its start: pressure; lost records 2/);
		assert.match(formatTelemetry(none), /Recording: unknown\. This host exposes no writer health/);
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
		result.otherRules = { ...result.rules[0], id: "(other rules)" };
		result.otherTools = { ...result.tools[0], name: "(other tools)" };
		result.continuation.nextCursor = "c".repeat(TELEMETRY_LIMITS.cursorChars);
		const row = {
			name: "2026-09-01.999999.jsonl",
			ordinal: 999_999,
			status: "partial" as const,
			bytesRead: TELEMETRY_LIMITS.bytes,
			size: Number.MAX_SAFE_INTEGER,
			startOffset: Number.MAX_SAFE_INTEGER,
			endOffset: Number.MAX_SAFE_INTEGER,
			bytesNotRead: Number.MAX_SAFE_INTEGER,
			issues: ["source-changed", "total-byte-limit", "incomplete-line", "malformed-line", "oversized-line", "read-error"] as const,
		};
		for (const day of result.coverage.days) {
			day.segmentsNotReached = Number.MAX_SAFE_INTEGER;
			day.issues = [...row.issues, "segment-limit", "line-limit"];
		}
		result.coverage.days[0].segments = Array.from({ length: TELEMETRY_LIMITS.segments + 1 }, () => ({ ...row, issues: [...row.issues] }));
		assert.ok(Buffer.byteLength(JSON.stringify(result)) <= TELEMETRY_LIMITS.structuredBytes);
		const text = formatTelemetry(result);
		assert.ok(Buffer.byteLength(text) <= TELEMETRY_LIMITS.outputBytes);
		assert.match(text, /Output omits \d+ tool rows and [1-9]\d* rule rows/);
		assert.match(text, /unknown evaluation coverage/);
	});
});
