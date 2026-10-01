import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JsonValue, TranscriptEvent } from "vitest-evals";
import { piSdkAdapter, runDeterministicChecks } from "../../../evals/subjects/pi-sdk.mts";
import triggerSuite from "../audit-trigger.eval.mts";
import outputSuite from "../audit-output.eval.mts";
import baselineSuite from "../audit-baseline.eval.mts";

const triggerPath = fileURLToPath(new URL("../audit-trigger.eval.mts", import.meta.url));
const outputPath = fileURLToPath(new URL("../audit-output.eval.mts", import.meta.url));
const baselinePath = fileURLToPath(new URL("../audit-baseline.eval.mts", import.meta.url));

type CaseInput = {
	seed: Array<{ role: "user" | "assistant"; content: string }>;
	prompt: string;
	fixture?: unknown;
};

const caseInput = (item: { input: unknown }): CaseInput => item.input as CaseInput;
const metadata = (item: { reviewMetadata?: unknown }): Record<string, unknown> =>
	(item.reviewMetadata ?? {}) as Record<string, unknown>;
const config = (variant: { config: unknown }): Record<string, unknown> => variant.config as Record<string, unknown>;
const baselinePromptFor = (prompt: string): string => {
	const hint = prompt.replace(/^\/skill:audit\s*/, "").trim();
	return hint === "" ? "Audit." : hint;
};

const call = (name: string, id = `${name}-call`, args: Record<string, JsonValue> = {}): TranscriptEvent => ({
	type: "tool_call",
	id,
	name,
	arguments: args,
});

const result = (name: string, id: string, content = "ok"): TranscriptEvent => ({
	type: "tool_result",
	toolCallId: id,
	name,
	content,
});

test("maintained audit suites validate through the existing Pi adapter", async () => {
	await access(fileURLToPath(new URL("../SKILL.md", import.meta.url)));
	for (const [suite, suitePath] of [
		[triggerSuite, triggerPath],
		[outputSuite, outputPath],
		[baselineSuite, baselinePath],
	] as const) {
		assert.ok(piSdkAdapter.validate, "the Pi adapter exposes suite validation");
		piSdkAdapter.validate({
			suitePath,
			subjectKind: suite.subject.kind,
			subjectConfig: suite.subject.config,
			cases: suite.cases,
		});
		for (const variant of suite.subject.variants) {
			assert.ok(
				piSdkAdapter.resolve({
					suitePath,
					subjectKind: suite.subject.kind,
					subjectConfig: suite.subject.config,
					variant,
				}),
			);
		}
	}
});

test("trigger suite keeps positive and near-miss populations separate", () => {
	assert.equal(triggerSuite.cases.length, 16);
	assert.equal(triggerSuite.cases.filter((item) => metadata(item).category === "positive").length, 8);
	assert.equal(triggerSuite.cases.filter((item) => metadata(item).category === "near-miss").length, 8);
	assert.equal(triggerSuite.subject.variants.length, 1);
	assert.equal(triggerSuite.subject.variants[0]?.id, "candidate");
	for (const item of triggerSuite.cases) {
		const input = caseInput(item);
		assert.equal(input.prompt.startsWith("/skill:"), false, item.id);
		assert.ok(!JSON.stringify({ seed: input.seed, prompt: input.prompt }).includes("semanticLedger"), `${item.id} hides review ledger from subject input`);
		assert.equal(input.fixture, undefined, `${item.id} keeps review metadata out of subject input`);
	}
});

test("direct and baseline suites keep their invocation arms distinct", () => {
	assert.equal(outputSuite.cases.length, 12);
	assert.equal(baselineSuite.cases.length, 12);
	assert.deepEqual(
		outputSuite.cases.map((item) => item.id),
		baselineSuite.cases.map((item) => item.id),
	);
	for (const item of outputSuite.cases) {
		const input = caseInput(item);
		assert.equal(input.prompt.startsWith("/skill:audit"), true, item.id);
		assert.equal(input.fixture, undefined, item.id);
	}
	for (const [index, item] of baselineSuite.cases.entries()) {
		const input = caseInput(item);
		const candidateInput = caseInput(outputSuite.cases[index] as { input: unknown });
		assert.equal(input.prompt.startsWith("/skill:audit"), false, item.id);
		assert.equal(input.prompt, baselinePromptFor(candidateInput.prompt), item.id);
		assert.equal(JSON.stringify(input).includes("SKILL.md"), false, item.id);
		assert.equal(input.fixture, undefined, item.id);
	}
	assert.equal(outputSuite.subject.variants[0]?.id, "candidate");
	assert.equal(baselineSuite.subject.variants[0]?.id, "plain-request");
	assert.equal(config(baselineSuite.subject.variants[0] as { config: unknown }).skills, undefined);
	assert.deepEqual(
		config(outputSuite.subject.variants[0] as { config: unknown }).appendSystemPrompt,
		config(baselineSuite.subject.variants[0] as { config: unknown }).appendSystemPrompt,
	);
});

test("deterministic floors check reachable tool evidence only", () => {
	const trigger = triggerSuite.cases.find((item) => item.id === "positive-retries");
	assert.ok(trigger);
	const triggerPass = runDeterministicChecks(
		"A bounded episode result.",
		trigger.checks,
		[call("read", "skill", { path: "/work/skills/audit/SKILL.md" }), result("read", "skill", "name: audit\n# Audit")],
		trigger.id,
	);
	assert.equal(triggerPass.every(({ passed }) => passed), true);
	const triggerMiss = runDeterministicChecks("No skill read.", trigger.checks, [], trigger.id);
	assert.equal(triggerMiss.find(({ checkId }) => checkId === "skill-file-read")?.passed, false);

	const nearMiss = triggerSuite.cases.find((item) => item.id === "near-security-code");
	assert.ok(nearMiss);
	assert.equal(
		runDeterministicChecks(
			"No candidate load.",
			nearMiss.checks,
			[call("read", "other-skill", { path: "/work/skills/harness/SKILL.md" })],
			nearMiss.id,
		).find(({ checkId }) => checkId === "skill-file-read")?.passed,
		true,
	);
	assert.equal(
		runDeterministicChecks("Candidate load.", nearMiss.checks, [call("read", "audit-skill", { path: "/work/skills/audit/SKILL.md" })], nearMiss.id).find(
			({ checkId }) => checkId === "skill-file-read",
		)?.passed,
		false,
	);

	const sourceCase = outputSuite.cases.find((item) => item.id === "o06-partial-reader");
	assert.ok(sourceCase);
	const sourceChecks = runDeterministicChecks(
		"Partial source evidence.",
		sourceCase.checks,
		[call("read", "reader", { path: "audit-reader-a.md" }), result("read", "reader", "accepted observations: 6")],
		sourceCase.id,
	);
	assert.equal(sourceChecks.every(({ passed }) => passed), true);
	assert.equal(sourceCase.checks.some(({ id }) => id.startsWith("no-")), false);

	const recurrence = outputSuite.cases.find((item) => item.id === "o12-registry-omission");
	assert.ok(recurrence);
	const recurrenceChecks = runDeterministicChecks(
		"Registry evidence remains semantic review.",
		recurrence.checks,
		[call("registry")],
		recurrence.id,
	);
	assert.ok(recurrenceChecks.some(({ checkId, passed }) => checkId === "bounded-output" && passed));
});
