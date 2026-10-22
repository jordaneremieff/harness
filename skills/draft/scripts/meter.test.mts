// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { filler } from "./test-kit.mts";

const METER = fileURLToPath(new URL("./meter.mts", import.meta.url));
const CONTRACT_DOC = fileURLToPath(new URL("../../../docs/conventions/prose-meter.md", import.meta.url));

function meter(args: string[], input: string, env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [METER, ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

type Json = Record<string, unknown>;

const SHAPE: Record<string, string[]> = {
	report: ["contract", "meterVersion", "input", "hard", "scored", "score", "calibration", "omitted"],
	input: ["kind", "words", "sentences", "lines", "target"],
	score: ["sq", "band", "reliable", "threshold", "components"],
	components: ["lexical", "geometry", "epistemic", "laundering"],
	component: ["value", "metrics"],
	calibration: ["cohort", "n", "date", "status"],
	omitted: ["hard", "scored", "perRuleCap", "byRule", "skippedFiles"],
	finding: ["rule", "severity", "line", "column", "text", "message", "file"],
};
const OPTIONAL = new Set(["target", "line", "column", "file"]);

function keysOf(value: unknown, allowed: string[], where: string): Json {
	assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${where} must be an object`);
	const record = value as Json;
	for (const key of Object.keys(record)) assert.ok(allowed.includes(key), `${where} has unexpected key ${key}`);
	for (const key of allowed) if (!OPTIONAL.has(key)) assert.ok(key in record, `${where} is missing ${key}`);
	return record;
}

function isNumber(value: unknown, where: string): void {
	assert.ok(typeof value === "number" && Number.isFinite(value), `${where} must be a number`);
}

function checkFinding(value: unknown, severity: string, where: string): void {
	const finding = keysOf(value, SHAPE.finding ?? [], where);
	assert.equal(typeof finding.rule, "string");
	assert.equal(finding.severity, severity);
	assert.equal(typeof finding.text, "string");
	assert.equal(typeof finding.message, "string");
	if (finding.line !== undefined) assert.ok(Number.isInteger(finding.line) && (finding.line as number) >= 1);
	if (finding.column !== undefined) assert.ok(Number.isInteger(finding.column) && (finding.column as number) >= 1);
}

function validateScore(value: unknown): void {
	const score = keysOf(value, SHAPE.score ?? [], "score");
	isNumber(score.sq, "score.sq");
	assert.ok((score.sq as number) >= 0 && (score.sq as number) <= 100);
	assert.ok(score.band === null || ["green", "amber", "red"].includes(score.band as string));
	assert.equal(typeof score.reliable, "boolean");
	assert.equal(score.band === null, score.reliable === false);
	isNumber(score.threshold, "score.threshold");
	const components = keysOf(score.components, SHAPE.components ?? [], "components");
	for (const name of SHAPE.components ?? []) {
		const component = keysOf(components[name], SHAPE.component ?? [], `component ${name}`);
		isNumber(component.value, `${name}.value`);
		assert.ok((component.value as number) >= 0 && (component.value as number) <= 1);
		for (const metric of Object.values(component.metrics as Json)) assert.ok(metric === null || typeof metric === "number");
	}
}

function validateTail(report: Json): void {
	const calibration = keysOf(report.calibration, SHAPE.calibration ?? [], "calibration");
	assert.ok(["uncalibrated", "calibrated-on-model-written-benchmark"].includes(calibration.status as string));
	const omitted = keysOf(report.omitted, SHAPE.omitted ?? [], "omitted");
	isNumber(omitted.hard, "omitted.hard");
	isNumber(omitted.scored, "omitted.scored");
	assert.ok(Array.isArray(omitted.skippedFiles));
}

/** Validate a report against the shape block in the contract document. */
function validateReport(value: unknown): void {
	const report = keysOf(value, SHAPE.report ?? [], "report");
	assert.equal(report.contract, 1);
	assert.equal(typeof report.meterVersion, "string");
	const input = keysOf(report.input, SHAPE.input ?? [], "input");
	assert.ok(["md", "html", "text", "ts", "js", "commit", "diff"].includes(input.kind as string));
	for (const key of ["words", "sentences", "lines"]) isNumber(input[key], `input.${key}`);
	assert.ok(Array.isArray(report.hard) && Array.isArray(report.scored));
	for (const finding of report.hard as unknown[]) checkFinding(finding, "hard", "hard finding");
	for (const finding of report.scored as unknown[]) checkFinding(finding, "scored", "scored finding");
	validateScore(report.score);
	validateTail(report);
}

test("the shape block in the contract document names exactly the members the validator knows", () => {
	const doc = readFileSync(CONTRACT_DOC, "utf8");
	const block = /```ts\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? "";
	const inDoc = new Set([...block.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]));
	const known = new Set(Object.values(SHAPE).flat());
	assert.deepEqual([...inDoc].sort(), [...known].sort());
	assert.match(block, /contract: 1;/);
});

test("the real meter's JSON conforms to the contract", () => {
	const text = `${filler(80)}\n\nA dash \u2014 here. To be honest, it works.\n\n- **Label:** text\n`;
	const { code, out } = meter(["--format", "json"], text);
	assert.equal(code, 1);
	validateReport(JSON.parse(out));
});

test("a clean text and a short text also conform", () => {
	validateReport(JSON.parse(meter(["--format", "json"], filler(80)).out));
	validateReport(JSON.parse(meter(["--format", "json"], "Short.").out));
	const diff = ["--- a/n.md", "+++ b/n.md", "@@ -0,0 +1,1 @@", "+Frankly, no."].join("\n");
	validateReport(JSON.parse(meter(["--format", "json", "--diff"], diff).out));
});

test("standard input, help and exit codes work through the real entry point", () => {
	assert.equal(meter([], filler(80)).code, 0);
	assert.equal(meter(["--help"], "").code, 0);
	assert.equal(meter(["--bogus"], "").code, 4);
	const help = meter(["--help"], "");
	assert.ok(help.out.startsWith("Usage:"));
	assert.equal(help.err, "");
});

test("NO_COLOR and non-terminal output carry no escape codes", () => {
	const { out } = meter([], filler(80), { NO_COLOR: "1" });
	assert.ok(!out.includes("\u001B["));
	assert.ok(!meter([], filler(80)).out.includes("\u001B["));
});

test("diagnostics go to standard error and data to standard output", () => {
	const bad = meter(["--format", "xml"], "x");
	assert.equal(bad.out, "");
	assert.match(bad.err, /^meter: /);
});

test("a large input is handled within a fixed time", () => {
	const started = Date.now();
	const { code } = meter(["--format", "json"], filler(200000));
	assert.equal(code, 0);
	assert.ok(Date.now() - started < 30000);
});
