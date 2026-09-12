import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEvidence, compileRule } from "./compiler.ts";
import { snapshotData } from "./data.ts";
import {
	captureProgramEvidence,
	evaluatePrograms,
	observationSelected,
	planInput,
	programSteps,
	type FactsProgram,
} from "./program.ts";
import type { RuleRecord } from "./rule.ts";

const always = { op: "exists" as const, path: ["input"] };
const facts = (id: string, spec: FactsProgram): RuleRecord => ({
	id,
	source: { kind: "package" },
	matcher: { kind: "declarative", language: "facts/v1", spec },
	definition: {
		purpose: "Preserve valid arguments.",
		authority: "exact",
		revision: "123456abcdef",
		state: "active",
		effect: spec.action.kind === "guide" ? "steer" : spec.action.kind === "deny" ? "block" : "correct",
		note: "Use the approved arguments.",
	},
	matcherAvailable: true,
	staleOverride: false,
});
const command = (effect: "steer" | "block" = "block"): RuleRecord => ({
	...facts("command.check", { phase: "input", when: always, action: { kind: "deny" }, onUnavailable: "skip" }),
	matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "restricted" } },
	definition: {
		purpose: "Preserve allowed commands.",
		authority: "steer-or-block",
		revision: "abcdef123456",
		state: "active",
		effect,
		note: "Use the approved command.",
	},
});
const context = {
	tool: "bash",
	scope: { cwd: "/project" },
	schema: {
		type: "object",
		properties: { command: { type: "string" } },
		required: ["command"],
		additionalProperties: false,
	},
};
const correction = () =>
	compileRule(
		facts("correct", {
			phase: "input",
			when: always,
			action: { kind: "substitute", path: ["command"], table: "commands" },
			data: ["commands"],
			onUnavailable: "deny",
		}),
	);
const data = snapshotData(
	[
		{
			kind: "table",
			name: "commands",
			revision: "012345abcdef",
			source: "approved-map",
			capturedAt: 1,
			rows: [{ key: "safe", value: "restricted target" }],
		},
	],
	2,
);

test("compiler captures immutable syntax and shares one identity across denial and guidance steps", () => {
	const record = command();
	const compiled = compileRule(record);
	assert.deepEqual(
		programSteps(compiled).map((rule) => [rule.id, rule.program.phase, rule.program.inputView]),
		[
			[record.id, "result", undefined],
			[record.id, "input", "original"],
			[record.id, "input", "effective"],
		],
	);
	record.matcher = { kind: "declarative", language: "command-shape/v1", spec: { command: "changed" } };
	assert.equal(
		captureEvidence([compiled], "bash", { command: "restricted target" }, context.scope).get(record.id),
		true,
	);
	assert.equal(
		captureEvidence([compiled], "read", { command: "restricted target" }, context.scope).get(record.id),
		false,
	);
	assert.equal(captureEvidence([compiled], "bash", undefined, context.scope).get(record.id), "unknown");
	assert.equal(captureEvidence([compiled], "bash", { command: "safe" }, context.scope).get(record.id), false);
});

test("one final plan evaluates every captured command and structured denial before rollback", () => {
	const structured = compileRule(
		facts("structured.check", {
			phase: "input",
			inputView: "effective",
			when: { op: "eq", path: ["input", "command"], value: "restricted target" },
			action: { kind: "deny" },
			onUnavailable: "skip",
		}),
	);
	const rules = [correction(), compileRule(command()), structured];
	const input = { command: "safe" };
	const plan = planInput(rules, input, { ...context, data });
	assert.equal(plan.denied, true);
	assert.equal(plan.changed, false);
	assert.deepEqual(plan.candidate, input);
	assert.deepEqual(
		plan.evaluations.filter((row) => row.inputView === "effective" && row.deny).map((row) => row.id),
		["command.check", "structured.check"],
	);
	assert.deepEqual(planInput([...rules].reverse(), input, { ...context, data }), plan);
	assert.deepEqual(input, { command: "safe" });
});

test("stale final gates refuse a candidate regardless of authoring syntax", () => {
	for (const gate of [
		compileRule(command()),
		compileRule(
			facts("structured.check", {
				phase: "input",
				inputView: "effective",
				when: always,
				action: { kind: "deny" },
				onUnavailable: "skip",
			}),
		),
	]) {
		const plan = planInput(
			[correction(), gate],
			{ command: "safe" },
			{ ...context, data, staleRules: new Set([gate.id]) },
		);
		assert.equal(plan.valid, false);
		assert.equal(plan.changed, false);
		assert.deepEqual(plan.candidate, { command: "safe" });
		assert.match(plan.problems.join(" "), /observation periods changed/);
	}
});

test("observational modes do not admit matches from hypothetical corrected commands", () => {
	const rules = [correction(), compileRule(command())];
	const plan = planInput(rules, { command: "safe" }, { ...context, data, applyCorrections: false });
	assert.equal(plan.denied, false);
	assert.equal(plan.matches.includes("command.check"), false);
	assert.deepEqual(plan.candidate, { command: "restricted target" });
});

test("command guidance uses admitted evidence and the declared mode without a second matcher gate", () => {
	for (const effect of ["block", "steer"] as const) {
		const rule = compileRule(command(effect));
		const plan = planInput([rule], { command: "restricted target" }, context);
		const matched = new Set(plan.matches);
		for (const mode of ["observe", "notice", "annotate", "enforce"] as const) {
			const result = evaluatePrograms([rule], "result", {
				...context,
				mode,
				matched,
				facts: { input: { command: "changed" }, result: { isError: false } },
			});
			assert.equal(result[0].truth, mode === "annotate" || (mode === "enforce" && effect === "steer"));
			assert.equal(
				evaluatePrograms([rule], "result", { ...context, mode, matched, facts: { result: { isError: true } } })[0]
					.truth,
				false,
			);
		}
	}
});

test("selectable input actions share the original condition and deliver guidance only after a matched success", () => {
	const record = facts("arguments.check", {
		phase: "input",
		selector: { tools: ["sample"] },
		when: { op: "eq", path: ["input", "bad"], value: true },
		action: { kind: "deny" },
		onUnavailable: "skip",
	});
	record.definition.authority = "steer-or-block";
	record.override = {
		effect: "steer",
		reason: "Approved guidance",
		againstDefinitionRevision: record.definition.revision,
		audit: { surface: "command", session: "test", model: null, at: "2026-09-11T00:00:00Z" },
	};
	const compiled = compileRule(record);
	assert.equal(compiled.program.action.kind, "guide");
	for (const bad of [true, false]) {
		const plan = planInput([compiled], { bad }, { tool: "sample" });
		assert.equal(plan.denied, false);
		const result = evaluatePrograms([compiled], "result", {
			tool: "sample",
			matched: new Set(plan.matches),
			facts: { result: { isError: false } },
		});
		assert.equal(result[0].truth, bad);
		assert.equal(
			evaluatePrograms([compiled], "result", {
				tool: "sample",
				matched: new Set(plan.matches),
				facts: { result: { isError: true } },
			})[0].truth,
			false,
		);
	}
});

test("applicability gates evidence, all execution steps, and state without granting unknown denial authority", () => {
	const applicability = { op: "eq" as const, path: ["context", "tools", "read", "active"], value: true };
	const records = [
		command(),
		facts("required.facts", {
			phase: "input",
			when: { op: "eq", path: ["input", "absent"], value: true },
			action: { kind: "deny" },
			onUnavailable: "deny",
		}),
	];
	for (const record of records) record.definition.applicability = applicability;
	const rules = records.map(compileRule);
	for (const active of [true, false, undefined]) {
		const facts = {
			input: { command: "restricted target" },
			context: { tools: { read: active === undefined ? {} : { active } } },
			result: { isError: false },
			outcome: { kind: "success" },
		};
		const scoped = { ...context, facts };
		const evidence = captureProgramEvidence(rules, scoped);
		assert.equal(evidence.get("command.check"), active === undefined ? "unknown" : active);
		const plan = planInput(rules, facts.input, scoped);
		assert.equal(plan.denied, active === true);
		assert.equal(plan.matches.includes("command.check"), active === true);
		assert.equal(plan.evaluations.find((row) => row.id === "required.facts")?.deny, active === true);
		const matched = new Set(["command.check"]);
		assert.equal(
			evaluatePrograms(rules, "result", { ...scoped, matched, mode: "annotate" })[0].truth,
			active === undefined ? "unknown" : active,
		);
		assert.equal(observationSelected(rules[0], { ...scoped, matched }), active === undefined ? "unknown" : active);
	}
});

test("an operation selector does not turn unknown applicability into action authority", () => {
	const record = facts("operation.check", {
		phase: "input",
		selector: { operations: ["send"] },
		when: always,
		action: { kind: "rename-key", path: [], from: "old", to: "name" },
		onUnavailable: "deny",
		state: { observe: { op: "eq", path: ["outcome", "kind"], value: "success" } },
	});
	record.definition.applicability = { op: "eq", path: ["context", "ready"], value: true };
	const rule = compileRule(record);
	const context = {
		tool: "sample",
		operation: "send",
		facts: { input: { old: "x" }, outcome: { kind: "success" } },
		schema: { type: "object" },
	};
	const plan = planInput([rule], { old: "x" }, context);
	assert.equal(plan.denied, false);
	assert.equal(plan.changed, false);
	assert.equal(plan.evaluations[0].truth, "unknown");
	assert.equal(plan.evaluations[0].applicable, "unknown");
	assert.equal(observationSelected(rule, context), "unknown");
});

test("selected guidance withholds denial authority when approved evidence is unavailable", () => {
	const record = facts("required.check", {
		phase: "input",
		when: { op: "eq", path: ["input", "absent"], value: "ok" },
		action: { kind: "deny" },
		onUnavailable: "deny",
	});
	record.definition.authority = "steer-or-block";
	record.override = {
		effect: "steer",
		reason: "Require guidance only",
		againstDefinitionRevision: record.definition.revision,
		audit: { surface: "command", session: "test", model: null, at: "2026-09-11T00:00:00Z" },
	};
	const plan = planInput([compileRule(record)], { value: "a" }, { tool: "sample" });
	assert.equal(plan.denied, false);
	assert.equal(plan.evaluations[0].truth, "unknown");
	assert.equal(plan.evaluations[0].action.kind, "guide");
	assert.equal(plan.evaluations[0].deny, false);
	record.override.effect = "block";
	assert.equal(planInput([compileRule(record)], { value: "a" }, { tool: "sample" }).denied, true);
	record.definition.authority = "exact";
	record.override.effect = "steer";
	assert.equal(planInput([compileRule(record)], { value: "a" }, { tool: "sample" }).denied, true);
});

test("selectable guidance retains its approved text", () => {
	const record = facts("guide.text", {
		phase: "input",
		when: always,
		action: { kind: "guide", text: "Preserve this exact instruction." },
		onUnavailable: "skip",
	});
	record.definition.authority = "steer-or-block";
	assert.deepEqual(compileRule(record).program.action, { kind: "guide", text: "Preserve this exact instruction." });
});

test("exact actions ignore effect overrides and retain their approved condition", () => {
	const record = facts("arguments.exact", {
		phase: "input",
		when: always,
		action: { kind: "rename-key", path: [], from: "old", to: "name" },
		onUnavailable: "skip",
	});
	record.override = {
		effect: "block",
		reason: "Invalid override",
		againstDefinitionRevision: record.definition.revision,
		audit: { surface: "command", session: "test", model: null, at: "2026-09-11T00:00:00Z" },
	};
	const compiled = compileRule(record);
	assert.deepEqual(compiled.program, record.matcher.kind === "declarative" ? record.matcher.spec : undefined);
	assert.equal(compiled.program.action.kind, "rename-key");
});
