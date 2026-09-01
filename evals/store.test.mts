import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { adjudicateRun, buildReviewArtifact, buildRunCoverage, prepareRun, readJson, writeJson } from "./store.mts";
import type {
	AdjudicationRecord,
	EvaluationPlan,
	EvaluationSuite,
	OperationalStatus,
	Participant,
	RunCoverage,
} from "./types.mts";

interface Fixture {
	root: string;
	directory: string;
	runId: string;
	coverage: RunCoverage;
}

const evaluationCase = {
	id: "case",
	title: "Case",
	input: { prompt: "Prompt" },
	checks: [{ id: "check", type: "contains-exact", config: { values: ["ok"] } }],
};
const variant = { id: "variant", description: "Variant", config: {} };
const suite: EvaluationSuite = {
	schemaVersion: 1,
	id: "suite",
	title: "Suite",
	subject: {
		adapter: "test",
		kind: "adhoc",
		description: "Test subject",
		config: {},
		variants: [variant],
	},
	cases: [evaluationCase],
	limits: {
		wall: { runTimeoutMs: 10_000, executionTimeoutMs: 1_000 },
		execution: { maxTotal: 2, maxTurnsEach: 1, maxOutputTokensEach: 10 },
		cost: { currency: "USD", maxObserved: 0, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: { requestedEffects: { providerNetwork: [], credentials: [], subject: [] } },
	adjudication: { policy: "human-required", criteria: ["Review usable output."] },
};
const participants: Participant[] = [
	{ id: "provider-a/model-a:off", provider: "provider-a", model: "model-a", thinking: "off" },
	{ id: "provider-b/model-b:off", provider: "provider-b", model: "model-b", thinking: "off" },
];

function plan(root: string): EvaluationPlan {
	return {
		schemaVersion: 1,
		suite: {
			id: suite.id,
			title: suite.title,
			path: join(root, "suite.eval.mts"),
			digest: `sha256:${"1".repeat(64)}`,
		},
		cases: [evaluationCase],
		variants: [variant],
		participants,
		invocation: {
			participantRoster: participants,
			repetitions: 1,
			grant: {
				providerNetwork: "approved-effects-only",
				credentialSources: { home: false, environment: [] },
				grantedEffects: [],
			},
		},
		limits: suite.limits,
		authority: suite.authority,
		subjectResolution: {
			adapter: "test",
			kind: "adhoc",
			config: {},
			variants: [{ id: variant.id, resolution: {} }],
		},
		digest: `sha256:${"2".repeat(64)}`,
	};
}

function executionId(participant: Participant): string {
	return `case--${participant.provider}--${participant.model}--${participant.thinking}--1--variant`;
}

function createFixture(status: OperationalStatus, errorSets: Array<Array<{ type: string; message: string }>>): Fixture {
	assert.equal(errorSets.length, participants.length);
	const root = mkdtempSync(join(tmpdir(), "evals-store-test-"));
	const evaluationPlan = plan(root);
	const prepared = prepareRun(root, evaluationPlan);
	const files: string[] = [];
	for (const [index, participant] of participants.entries()) {
		const id = executionId(participant);
		const file = `${id}.json`;
		writeJson(join(prepared.directory, "executions", file), {
			execution: {
				executionId: id,
				caseId: evaluationCase.id,
				variantId: variant.id,
				participantId: participant.id,
				repetition: 1,
				blindLabel: "A",
			},
			case: { id: evaluationCase.id, title: evaluationCase.title },
			participant,
			result: {
				output: {
					value: { text: index === 0 ? "ok" : "" },
					effective: { provider: participant.provider, model: participant.model },
					checks: [{ checkId: "check", type: "contains-exact", passed: true, message: "ok" }],
				},
				usage: { provider: participant.provider, model: participant.model },
				errors: errorSets[index],
			},
		});
		files.push(file);
	}
	writeJson(join(prepared.directory, "execution-files.json"), { files });
	const coverage = buildRunCoverage(prepared.directory, evaluationPlan);
	prepared.state.phase = "terminal";
	prepared.state.operational = { status, exitCode: status === "completed" ? 0 : 1 };
	prepared.state.coverage = coverage;
	writeJson(join(prepared.directory, "state.json"), prepared.state);
	writeJson(join(prepared.directory, "review.json"), buildReviewArtifact(prepared.directory, suite, prepared.state));
	return { root, directory: prepared.directory, runId: prepared.runId, coverage };
}

function removeFixture(fixture: Fixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
}

const providerError = [
	{ type: "AssistantError", message: "Provider refused the request." },
	{ type: "AssistantStopReason", message: "Assistant stopped with error." },
];

describe("run coverage and review evidence", () => {
	it("persists partial coverage and removes excluded checks from review evidence", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const usableId = executionId(participants[0]);
			const excludedId = executionId(participants[1]);
			assert.deepEqual(fixture.coverage, {
				plannedExecutions: 2,
				usableExecutions: 1,
				excludedExecutions: 1,
				usableExecutionIds: [usableId],
				exclusions: [{ executionId: excludedId, errorTypes: ["AssistantError", "AssistantStopReason"] }],
			});
			const state = readJson<{ coverage: RunCoverage }>(join(fixture.directory, "state.json"));
			const review = readJson<{
				coverage: RunCoverage;
				cases: Array<{
					entries: Array<{
						executionId: string;
						evidenceStatus: string;
						checks?: unknown;
						exclusion?: { executionId: string; errorTypes: string[] };
					}>;
				}>;
			}>(join(fixture.directory, "review.json"));
			assert.deepEqual(state.coverage, fixture.coverage);
			assert.deepEqual(review.coverage, fixture.coverage);
			const usable = review.cases[0].entries.find((entry) => entry.executionId === usableId)!;
			const excluded = review.cases[0].entries.find((entry) => entry.executionId === excludedId)!;
			assert.equal(usable.evidenceStatus, "usable");
			assert.ok(Object.hasOwn(usable, "checks"));
			assert.equal(excluded.evidenceStatus, "excluded");
			assert.ok(!Object.hasOwn(excluded, "checks"));
			assert.deepEqual(excluded.exclusion, {
				executionId: excludedId,
				errorTypes: ["AssistantError", "AssistantStopReason"],
			});
		} finally {
			removeFixture(fixture);
		}
	});
});

describe("adjudicateRun", () => {
	it("records a scoped partial pass over exactly the usable executions", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const state = adjudicateRun(
				fixture.root,
				fixture.runId,
				"pass",
				"Usable evidence satisfies the criteria.",
				"A",
				"usable-executions",
			);
			const record = readJson<AdjudicationRecord>(join(fixture.directory, "adjudication.json"));
			assert.equal(state.quality.status, "pass");
			assert.deepEqual(record.scope, {
				type: "usable-executions",
				executionIds: [executionId(participants[0])],
			});
		} finally {
			removeFixture(fixture);
		}
	});

	it("refuses an unscoped partial pass", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			assert.throws(
				() => adjudicateRun(fixture.root, fixture.runId, "pass", "Unscoped conclusion."),
				/explicitly scoped to usable executions/,
			);
		} finally {
			removeFixture(fixture);
		}
	});

	it("keeps an all-errored run restricted to inconclusive", () => {
		const fixture = createFixture("blocked", [providerError, providerError]);
		try {
			assert.throws(
				() =>
					adjudicateRun(fixture.root, fixture.runId, "pass", "All executions errored.", undefined, "usable-executions"),
				/operationally incomplete run permits only an inconclusive adjudication/,
			);
		} finally {
			removeFixture(fixture);
		}
	});

	it("leaves completed-run adjudication unaffected", () => {
		const fixture = createFixture("completed", [[], []]);
		try {
			const state = adjudicateRun(fixture.root, fixture.runId, "pass", "All evidence satisfies the criteria.");
			const record = readJson<AdjudicationRecord>(join(fixture.directory, "adjudication.json"));
			assert.equal(state.quality.status, "pass");
			assert.ok(!Object.hasOwn(record, "scope"));
		} finally {
			removeFixture(fixture);
		}
	});

	it("keeps a scoped partial adjudication immutable", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			adjudicateRun(
				fixture.root,
				fixture.runId,
				"pass",
				"Usable evidence satisfies the criteria.",
				undefined,
				"usable-executions",
			);
			assert.throws(
				() =>
					adjudicateRun(fixture.root, fixture.runId, "fail", "Replacement verdict.", undefined, "usable-executions"),
				/adjudication records are immutable/,
			);
		} finally {
			removeFixture(fixture);
		}
	});
});
