// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { COMPONENTS, GROUPS, loadRules, parseRules, RulesError } from "./rules.mts";
import { ALL_OPTIONS, analyzerFor, count, run } from "./test-kit.mts";
import { analyzeText } from "./analyze.mts";

const set = loadRules();

function mutated(change: (data: Record<string, unknown>) => void): unknown {
	const copy = JSON.parse(JSON.stringify(set)) as Record<string, unknown>;
	change(copy);
	return copy;
}

test("the shipped rule data validates and covers every group", () => {
	assert.ok(set.rules.length > 0);
	const groups = new Set(set.rules.map((rule) => rule.group));
	for (const group of GROUPS) assert.ok(groups.has(group), `group ${group} has no rule`);
	for (const rule of set.rules) {
		if (rule.severity === "scored" && rule.component !== "none") assert.ok(COMPONENTS.includes(rule.component as never));
	}
});

test("every rule fires on its hit examples and stays quiet on its clean examples", () => {
	const analyzer = analyzerFor(ALL_OPTIONS);
	const failures: string[] = [];
	for (const rule of set.rules) {
		const kind = rule.exampleKind ?? "md";
		for (const text of rule.examples.hit) {
			const report = analyzeText(analyzer, text, kind as never);
			if (count(report, rule.id) < 1) failures.push(`${rule.id} did not fire on: ${JSON.stringify(text)}`);
		}
		for (const text of rule.examples.clean) {
			const report = analyzeText(analyzer, text, kind as never);
			if (count(report, rule.id) !== 0) failures.push(`${rule.id} fired on clean example: ${JSON.stringify(text)}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("bold-label examples each produce exactly one finding", () => {
	const rule = set.rules.find((entry) => entry.id === "structure.bold-label");
	for (const text of rule?.examples.hit ?? []) assert.equal(count(run(text), "structure.bold-label"), 1, text);
});

test("rule ids are unique and carry their group", () => {
	const ids = set.rules.map((rule) => rule.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const rule of set.rules) assert.ok(rule.id.startsWith(`${rule.group}.`));
});

test("no rule matches pathological input slowly", () => {
	const analyzer = analyzerFor(ALL_OPTIONS);
	const nasty = [
		"a, ".repeat(4000),
		`${"word ".repeat(3000)}not only`,
		`(${"x".repeat(5000)}`,
		"- ".repeat(3000),
		`${"it is not ".repeat(800)}`,
		"**".repeat(3000),
		"[".repeat(3000),
	];
	for (const text of nasty) {
		const started = Date.now();
		analyzeText(analyzer, text, "md");
		assert.ok(Date.now() - started < 3000, `slow input: ${text.slice(0, 20)}`);
	}
});

test("the loader rejects malformed rule data", () => {
	const cases: Array<[string, (data: Record<string, unknown>) => void]> = [
		["unknown top-level key", (data) => (data.extra = 1)],
		["wrong version", (data) => (data.version = 2)],
		["bad weights sum", (data) => ((data.scoring as { componentWeights: { lexical: number } }).componentWeights.lexical = 0.9)],
		["unknown rule key", (data) => ((data.rules as Array<Record<string, unknown>>)[0].bogus = 1)],
		["bad regex", (data) => ((data.rules as Array<Record<string, unknown>>)[0].pattern = "(")],
		["empty-matching regex", (data) => ((data.rules as Array<Record<string, unknown>>)[0].pattern = "a*")],
		["unknown detector", (data) => {
			const rules = data.rules as Array<Record<string, unknown>>;
			const index = rules.findIndex((rule) => rule.detector !== undefined);
			rules[index].detector = "nope";
		}],
		["duplicate id", (data) => {
			const rules = data.rules as Array<Record<string, unknown>>;
			rules[1].id = rules[0].id;
		}],
		["hard rule with weight", (data) => ((data.rules as Array<Record<string, unknown>>)[0].weight = 1)],
		["missing examples", (data) => delete (data.rules as Array<Record<string, unknown>>)[0].examples],
		["id without group prefix", (data) => ((data.rules as Array<Record<string, unknown>>)[0].id = "other.name")],
	];
	for (const [name, change] of cases) {
		assert.throws(() => parseRules(mutated(change)), RulesError, name);
	}
});

test("a rule needs exactly one of pattern, terms or detector", () => {
	const data = mutated((value) => {
		(value.rules as Array<Record<string, unknown>>)[0].terms = ["extra"];
	});
	assert.throws(() => parseRules(data), /exactly one/);
});

test("loadRules reports unreadable and non-JSON files", () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-rules-"));
	assert.throws(() => loadRules(join(dir, "missing.json")), /cannot read/);
	const bad = join(dir, "bad.json");
	writeFileSync(bad, "{ not json");
	assert.throws(() => loadRules(bad), /not valid JSON/);
});
