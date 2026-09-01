import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import wtfSuite from "../prompts/wtf.eval.mts";
import { createPlan, parseParticipant, validateSuite } from "./core.mts";
import type { EvaluationSuite, SubjectAdapter } from "./types.mts";

const neutralSuite = (): EvaluationSuite => ({
	schemaVersion: 1,
	id: "neutral-suite",
	title: "Neutral suite",
	subject: {
		adapter: "test-adapter",
		kind: "adhoc",
		description: "A neutral test subject.",
		config: {},
		variants: [{ id: "one", description: "One", config: { source: "inline" } }],
	},
	cases: [
		{
			id: "case-one",
			title: "Case one",
			input: { prompt: "hello" },
			checks: [{ id: "present", type: "contains-exact", config: { values: ["hello"] } }],
		},
	],
	limits: {
		wall: { runTimeoutMs: 10_000, executionTimeoutMs: 1_000 },
		execution: { maxTotal: 4, maxTurnsEach: 1, maxOutputTokensEach: 100 },
		cost: { currency: "USD", maxObserved: 0, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: { requestedEffects: { providerNetwork: ["effect"], credentials: [], subject: [] } },
	adjudication: { policy: "deterministic-only", criteria: [] },
});

const adapter: SubjectAdapter = {
	id: "test-adapter",
	resolve: ({ variant }) => ({ variantDigest: variant.id }),
	run: async () => {
		throw new Error("not used");
	},
};

describe("neutral suite contract", () => {
	it("builds a stable plan with exact invocation data and authority", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-core-"));
		try {
			const suitePath = join(directory, "suite.eval.mts");
			writeFileSync(suitePath, "export default {};\n");
			const participant = parseParticipant("anthropic/claude-example:high");
			const grant = {
				providerNetwork: "approved-effects-only" as const,
				credentialSources: { home: true, environment: [] },
				grantedEffects: ["effect"],
			};
			const first = createPlan(neutralSuite(), suitePath, [participant], 2, adapter, grant);
			const second = createPlan(neutralSuite(), suitePath, [participant], 2, adapter, grant);
			assert.equal(first.digest, second.digest);
			assert.deepEqual(first.invocation, { participantRoster: [participant], repetitions: 2, grant });
			assert.equal(first.subjectResolution.adapter, "test-adapter");
			assert.equal(first.authority.requestedEffects.providerNetwork[0], "effect");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("runs adapter case validation before subject resolution", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-core-validation-"));
		try {
			const suitePath = join(directory, "suite.eval.mts");
			writeFileSync(suitePath, "export default {};\n");
			const participant = parseParticipant("anthropic/claude-example:off");
			const calls: string[] = [];
			const validatingAdapter: SubjectAdapter = {
				id: "test-adapter",
				validate: ({ cases }) => {
					calls.push(`validate:${cases[0]?.id}`);
					throw new Error(`case ${cases[0]?.id} check ${cases[0]?.checks[0]?.id} is invalid`);
				},
				resolve: () => {
					calls.push("resolve");
					return {};
				},
				run: async () => {
					throw new Error("not used");
				},
			};
			assert.throws(
				() =>
					createPlan(neutralSuite(), suitePath, [participant], 1, validatingAdapter, {
						providerNetwork: "approved-effects-only",
						credentialSources: { home: true, environment: [] },
						grantedEffects: ["effect"],
					}),
				/case case-one check present is invalid/,
			);
			assert.deepEqual(calls, ["validate:case-one"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("covers variant extension flags in the approved plan digest", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-core-flags-"));
		try {
			const suitePath = join(directory, "suite.eval.mts");
			writeFileSync(suitePath, "export default {};\n");
			const participant = parseParticipant("anthropic/claude-example:off");
			const grant = {
				providerNetwork: "approved-effects-only" as const,
				credentialSources: { home: true, environment: [] },
				grantedEffects: ["effect"],
			};
			const suite = neutralSuite();
			suite.subject.variants[0]!.config = { extensionFlags: { enabled: true, mode: "strict" } };
			const equivalent = neutralSuite();
			equivalent.subject.variants[0]!.config = { extensionFlags: { mode: "strict", enabled: true } };
			const changed = neutralSuite();
			changed.subject.variants[0]!.config = { extensionFlags: { enabled: true, mode: "advisory" } };
			const planned = createPlan(suite, suitePath, [participant], 1, adapter, grant);
			const equivalentPlan = createPlan(equivalent, suitePath, [participant], 1, adapter, grant);
			const changedPlan = createPlan(changed, suitePath, [participant], 1, adapter, grant);
			assert.equal(planned.digest, equivalentPlan.digest);
			assert.notEqual(planned.digest, changedPlan.digest);
			assert.deepEqual(planned.variants[0]?.config, suite.subject.variants[0]?.config);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects data that JSON.stringify would silently alter", () => {
		for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, 1n]) {
			const suite = neutralSuite() as unknown as Record<string, unknown>;
			(suite.subject as Record<string, unknown>).config = { invalid };
			assert.throws(() => validateSuite(suite), /unsupported|non-finite/);
		}
		const sparse = neutralSuite() as unknown as Record<string, unknown>;
		(sparse.subject as Record<string, unknown>).config = new Array(2);
		assert.throws(() => validateSuite(sparse), /sparse array/);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const cycleSuite = neutralSuite() as unknown as Record<string, unknown>;
		(cycleSuite.subject as Record<string, unknown>).config = cyclic;
		assert.throws(() => validateSuite(cycleSuite), /cycle/);
	});
});

describe("maintained /wtf suite", () => {
	it("uses only the approved fixture classes and the account-substituting ablation", () => {
		assert.deepEqual(
			wtfSuite.cases.map((value) => value.id),
			["caught-up", "return", "correction"],
		);
		const ablation = wtfSuite.subject.variants.find((value) => value.id === "neutral-ablation");
		const config = ablation?.config as { promptTemplates?: Array<{ source?: { inline?: string } }> };
		const baselinePrompt = config.promptTemplates?.[0];
		assert.ok(baselinePrompt?.source);
		assert.equal(
			baselinePrompt.source.inline,
			`Rewrite the most recent assistant reply so it is clear and actionable. Return only the replacement. Do not continue the underlying task. Operator account: ${"$"}{ARGUMENTS:-none}.`,
		);
		for (const evaluationCase of wtfSuite.cases) {
			const input = evaluationCase.input as { fixture?: Record<string, unknown> };
			assert.ok(input.fixture?.semanticLedger);
			assert.ok(input.fixture?.protectedExactSpans);
			assert.ok(input.fixture?.forbiddenCanaries);
			assert.ok(input.fixture?.forbiddenTaskActions);
			assert.ok(input.fixture?.actualNextStep);
		}
		assert.equal(wtfSuite.adjudication.policy, "human-required");
	});
});
