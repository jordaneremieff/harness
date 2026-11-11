import assert from "node:assert/strict";
import { test } from "node:test";
import { PACKAGE_CATALOG } from "./catalog.ts";
import { compileRule } from "./compiler.ts";
import { UNKNOWN } from "./data.ts";
import { validatePackageDefinitionRow } from "./local-rules.ts";
import { planInput } from "./program.ts";
import type { RuleRecord } from "./rule.ts";
import { hasCodeMatcher } from "./shell-rules.ts";

function installed(id: string): RuleRecord {
	const row = PACKAGE_CATALOG.find((entry) => entry.id === id);
	assert.ok(row, id);
	return {
		id,
		source: { kind: "package" },
		matcher: row.matcher,
		definition: { ...row, state: "active" },
		matcherAvailable: true,
		staleOverride: false,
	};
}

test("every installed policy has a validated purpose, action authority, and source revision", () => {
	assert.equal(new Set(PACKAGE_CATALOG.map((row) => row.id)).size, PACKAGE_CATALOG.length);
	for (const row of PACKAGE_CATALOG) {
		assert.deepEqual(validatePackageDefinitionRow(row), row);
		assert.ok(row.purpose.trim().length > 0, row.id);
		if (row.matcher.kind === "code") assert.equal(hasCodeMatcher(row.matcher.key), true, row.id);
		assert.equal(compileRule(installed(row.id)).id, row.id);
	}
	for (const id of [
		"arguments.schema",
		"recovery.repeated-errors",
		"recovery.pillars-application",
		"resources.output-volume",
	])
		assert.equal(installed(id).source.kind, "package");
});

test("command defaults retain slow-traverser gates and guide other preferences", () => {
	const blocked = ["form.find-discovery", "form.ls-recursive", "form.du-traversal", "bounds.find-output-uncapped",
		"bounds.grep-recursive-uncapped", "bounds.ls-recursive-uncapped", "bounds.du-uncapped"];
	const guided = ["routing.cat-read", "routing.cat-pipe", "routing.head-slice", "routing.tail-slice", "routing.sed-slice",
		"routing.inline-script-read", "routing.grep-pipe", "form.grep-file", "form.env-grep", "bounds.fd-uncapped",
		"bounds.rg-files-uncapped", "bounds.rg-search-uncapped", "bounds.git-grep-uncapped", "bounds.false-cap"];
	const commandRows = PACKAGE_CATALOG.filter((row) => row.matcher.kind === "code");
	assert.deepEqual(commandRows.filter((row) => row.effect === "block").map((row) => row.id).sort(), blocked.sort());
	assert.deepEqual(commandRows.filter((row) => row.effect === "steer").map((row) => row.id).sort(), guided.sort());
	assert.equal(installed("arguments.schema").definition.effect, "block");
	assert.equal(installed("recovery.repeated-errors").definition.effect, "steer");
	assert.equal(PACKAGE_CATALOG.some((row) => /deadline|timeout/.test(row.id)), false);
	const output = installed("resources.output-volume");
	assert.match(output.definition.note, /Preserve required complete reads/);
	assert.match(output.definition.note, /does not establish unnecessary breadth/);
	assert.equal(output.matcher.kind === "declarative" && output.matcher.language === "facts/v1" && output.matcher.spec.action.kind === "guide" && output.matcher.spec.action.text, output.definition.note);
});

test("installed argument guard refuses only known-invalid final arguments", () => {
	const rules = [compileRule(installed("arguments.schema"))];
	const schema = {
		type: "object",
		properties: { count: { type: "integer" } },
		required: ["count"],
		additionalProperties: false,
	};
	assert.equal(planInput(rules, { count: 2 }, { tool: "sample", schema }).denied, false);
	const invalid = planInput(rules, { count: "two" }, { tool: "sample", schema });
	assert.equal(invalid.denied, true);
	assert.deepEqual(invalid.candidate, { count: "two" });
	assert.equal(invalid.evaluations[0].inputView, "effective");
	const unavailable = planInput(rules, { count: "two" }, { tool: "sample" });
	assert.equal(unavailable.denied, false);
	assert.equal(unavailable.evaluations[0].truth, "unknown");
});

test("installed reader replacements require an active read tool rather than an assumed alternative", () => {
	const rules = [compileRule(installed("routing.cat-read"))];
	for (const active of [true, false, UNKNOWN]) {
		const plan = planInput(
			rules,
			{ command: "cat README.md" },
			{
				tool: "bash",
				scope: { cwd: "/project" },
				facts: { context: { tools: { read: { active } } } },
			},
		);
		assert.equal(plan.denied, false);
		assert.equal(plan.matches.includes("routing.cat-read"), active === true);
	}
	const missing = planInput(rules, { command: "cat README.md" }, { tool: "bash" });
	assert.equal(missing.denied, false);
	assert.equal(missing.matches.length, 0);
});
