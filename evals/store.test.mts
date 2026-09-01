import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	adjudicateRun,
	buildReviewArtifact,
	buildRunCoverage,
	deleteRun,
	inspectRun,
	listExecutionEvidence,
	prepareRun,
	readJson,
	writeJson,
} from "./store.mts";
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

function transcriptEvents(index: number) {
	return [
		{ type: "tool_call", id: `call-${index}`, name: "fixture-tool", arguments: { index } },
		{ type: "tool_result", toolCallId: `call-${index}`, name: "fixture-tool", content: `result-${index}` },
	];
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
				events: transcriptEvents(index),
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

describe("store lifecycle and corruption", () => {
	it("rejects invalid JSON and malformed execution manifests", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-manifest-"));
		try {
			const manifestPath = join(root, "execution-files.json");
			writeFileSync(manifestPath, "{not-json");
			assert.throws(() => listExecutionEvidence(root), SyntaxError);

			writeJson(manifestPath, { files: "execution.json" });
			assert.throws(() => listExecutionEvidence(root), /Execution evidence manifest must contain a files array/);
			writeJson(manifestPath, { files: ["../execution.json"] });
			assert.throws(() => listExecutionEvidence(root), /Invalid execution evidence path/);

			writeJson(manifestPath, { files: [] });
			assert.deepEqual(listExecutionEvidence(root), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires a readable state file when inspecting a run", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-state-"));
		try {
			const prepared = prepareRun(root, plan(root));
			const statePath = join(prepared.directory, "state.json");
			rmSync(statePath);
			assert.throws(() => inspectRun(root, prepared.runId, false), /state\.json/);
			writeFileSync(statePath, "{not-json");
			assert.throws(() => inspectRun(root, prepared.runId, false), SyntaxError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows a missing review before terminalization but rejects a corrupt review", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-review-"));
		try {
			const prepared = prepareRun(root, plan(root));
			const inspected = inspectRun(root, prepared.runId, false);
			assert.deepEqual(inspected.state, prepared.state);
			assert.equal(Object.hasOwn(inspected, "review"), false);

			const reviewPath = join(prepared.directory, "review.json");
			writeFileSync(reviewPath, "{not-json");
			assert.throws(() => inspectRun(root, prepared.runId, false), SyntaxError);
			writeJson(reviewPath, { status: "reviewable" });
			assert.deepEqual(inspectRun(root, prepared.runId, false).review, { status: "reviewable" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a run intact when delete approval and root guards reject it", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-delete-"));
		const outside = mkdtempSync(join(tmpdir(), "evals-store-outside-"));
		try {
			const prepared = prepareRun(root, plan(root));
			assert.throws(() => deleteRun(root, prepared.runId, "wrong-approval"), /exactly match the run id/);
			assert.throws(() => deleteRun(root, "../outside", "../outside"), /Invalid run id/);
			assert.equal(existsSync(prepared.directory), true);

			const linkedRunId = "20260101T000000Z-00000000";
			symlinkSync(outside, join(root, linkedRunId), "dir");
			assert.throws(() => deleteRun(root, linkedRunId, linkedRunId), /outside the evidence root/);
			assert.equal(existsSync(outside), true);
			assert.equal(existsSync(prepared.directory), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("deletes an existing run only with exact approval", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-delete-success-"));
		try {
			const prepared = prepareRun(root, plan(root));
			deleteRun(root, prepared.runId, prepared.runId);
			assert.equal(existsSync(prepared.directory), false);
			assert.throws(() => deleteRun(root, prepared.runId, prepared.runId), /Run does not exist/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

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

	it("classifies an interrupted manifest as usable evidence plus a missing exclusion", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-store-interrupted-"));
		try {
			const evaluationPlan = plan(root);
			const prepared = prepareRun(root, evaluationPlan);
			const usableId = executionId(participants[0]);
			const missingId = executionId(participants[1]);
			const file = `${usableId}.json`;
			writeJson(join(prepared.directory, "executions", file), {
				execution: { executionId: usableId },
				result: { errors: [] },
			});
			writeJson(join(prepared.directory, "execution-files.json"), { files: [file] });

			assert.deepEqual(buildRunCoverage(prepared.directory, evaluationPlan), {
				plannedExecutions: 2,
				usableExecutions: 1,
				excludedExecutions: 1,
				usableExecutionIds: [usableId],
				exclusions: [{ executionId: missingId, errorTypes: ["MissingExecutionEvidence"] }],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes transcript events in usable and excluded review entries", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const review = readJson<{
				cases: Array<{ entries: Array<{ executionId: string; events: unknown }> }>;
			}>(join(fixture.directory, "review.json"));
			const usable = review.cases[0].entries.find((entry) => entry.executionId === executionId(participants[0]))!;
			const excluded = review.cases[0].entries.find((entry) => entry.executionId === executionId(participants[1]))!;
			assert.deepEqual(usable.events, transcriptEvents(0));
			assert.deepEqual(excluded.events, transcriptEvents(1));
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
