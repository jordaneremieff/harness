import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	adjudicateRun,
	blindVariantLabels,
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

function entryFor<T extends { executionId: string }>(entries: T[], executionId: string): T {
	const entry = entries.find((candidate) => candidate.executionId === executionId);
	assert.ok(entry, `review entry ${executionId} must exist`);
	return entry;
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
			const usable = entryFor(review.cases[0].entries, usableId);
			const excluded = entryFor(review.cases[0].entries, excludedId);
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
			const usable = entryFor(review.cases[0].entries, executionId(participants[0]));
			const excluded = entryFor(review.cases[0].entries, executionId(participants[1]));
			assert.deepEqual(usable.events, transcriptEvents(0));
			assert.deepEqual(excluded.events, transcriptEvents(1));
		} finally {
			removeFixture(fixture);
		}
	});
});

describe("inspection views", () => {
	it("projects complete evidence without payloads or raw identities", () => {
		const fixture = createFixture("completed", [[], []]);
		try {
			const summary = inspectRun(fixture.root, fixture.runId, false, { summary: true });
			assert.deepEqual(summary, {
				view: { mode: "summary", scope: "whole-run", caseIds: ["case"] },
				runId: fixture.runId,
				state: { phase: "terminal", operational: { status: "completed" }, quality: { status: "not_assessed" } },
				reviewStatus: "available",
				coverage: {
					source: "current-execution-artifacts",
					wholeRun: { plannedExecutions: 2, usableExecutions: 2, excludedExecutions: 0, missingExecutions: 0 },
				},
				note: "Usable evidence has no execution errors; it is not a quality verdict. Missing executions are included in excludedExecutions.",
				cases: [
					{
						id: "case",
						title: "Case",
						coverage: { plannedExecutions: 2, usableExecutions: 2, excludedExecutions: 0, missingExecutions: 0 },
						entries: participants.map(({ provider, model, thinking }) => ({
							label: "A",
							participant: { provider, model, thinking },
							repetition: 1,
							evidenceStatus: "usable",
							reviewEntry: "available",
						})),
					},
				],
			});
			const full = inspectRun(fixture.root, fixture.runId, false);
			assert.deepEqual(full, {
				state: readJson(join(fixture.directory, "state.json")),
				review: readJson(join(fixture.directory, "review.json")),
			});
			assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length);
		} finally {
			removeFixture(fixture);
		}
	});

	it("keeps excluded evidence and missing planned repetitions distinct without counting them twice", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const planned = readJson<EvaluationPlan>(join(fixture.directory, "plan.json"));
			planned.invocation.repetitions = 2;
			planned.variants.push({ id: "other-variant", description: "Other", config: { marker: "variant-config-canary" } });
			writeJson(join(fixture.directory, "plan.json"), planned);
			const labels = blindVariantLabels(planned, fixture.runId);
			writeJson(join(fixture.directory, "variant-map.json"), { variantToLabel: labels });
			const summary = inspectRun(fixture.root, fixture.runId, false, { summary: true });
			assert.deepEqual(summary.coverage, {
				source: "current-execution-artifacts",
				wholeRun: { plannedExecutions: 8, usableExecutions: 1, excludedExecutions: 7, missingExecutions: 6 },
			});
			const cases = summary.cases as Array<{
				entries: Array<{ label: string; repetition: number; evidenceStatus: string; errorTypes?: string[] }>;
			}>;
			assert.equal(cases[0].entries.length, 8);
			assert.deepEqual(cases[0].entries[4].errorTypes, ["AssistantError", "AssistantStopReason"]);
			assert.equal(cases[0].entries[4].evidenceStatus, "excluded");
			assert.equal(cases[0].entries[1].label, labels["other-variant"]);
			assert.equal(cases[0].entries[2].repetition, 2);
			assert.equal(cases[0].entries[2].evidenceStatus, "missing");
			assert.deepEqual(cases[0].entries[2].errorTypes, ["MissingExecutionEvidence"]);
			for (const omitted of [
				"other-variant",
				"variant-config-canary",
				"executionId",
				"checks",
				"events",
				"Provider refused",
			]) {
				assert.ok(!JSON.stringify(summary).includes(omitted), omitted);
			}
		} finally {
			removeFixture(fixture);
		}
	});

	it("distinguishes a present execution error name from actual absent evidence", () => {
		const fixture = createFixture("partial", [
			[],
			[{ type: "MissingExecutionEvidence", message: "Recorded execution error." }],
		]);
		try {
			const summary = inspectRun(fixture.root, fixture.runId, false, { summary: true });
			assert.deepEqual(summary.coverage, {
				source: "current-execution-artifacts",
				wholeRun: { plannedExecutions: 2, usableExecutions: 1, excludedExecutions: 1, missingExecutions: 0 },
			});
			const cases = summary.cases as Array<{ entries: Array<{ evidenceStatus: string; errorTypes?: string[] }> }>;
			assert.equal(cases[0].entries[1].evidenceStatus, "excluded");
			assert.deepEqual(cases[0].entries[1].errorTypes, ["MissingExecutionEvidence"]);
			writeJson(join(fixture.directory, "execution-files.json"), { files: [`${executionId(participants[1])}.json`] });
			const selected = inspectRun(fixture.root, fixture.runId, false, { caseIds: ["case"] });
			const totals = { plannedExecutions: 2, usableExecutions: 0, excludedExecutions: 2, missingExecutions: 1 };
			assert.deepEqual(selected.coverage, {
				source: "current-execution-artifacts",
				wholeRun: totals,
				selectedCases: totals,
			});
			const selectedCases = selected.cases as typeof cases;
			assert.deepEqual(
				selectedCases[0].entries.map((entry) => entry.evidenceStatus),
				["missing", "excluded"],
			);
		} finally {
			removeFixture(fixture);
		}
	});

	it("shows planned evidence and absent review before execution without creating artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "evals-inspect-prepared-"));
		try {
			const prepared = prepareRun(root, plan(root));
			for (const phase of ["prepared", "running", "terminal"] as const) {
				prepared.state.phase = phase;
				if (phase === "terminal") prepared.state.operational.status = "failed";
				writeJson(join(prepared.directory, "state.json"), prepared.state);
				const summary = inspectRun(root, prepared.runId, false, { summary: true });
				assert.deepEqual(summary.coverage, {
					source: "current-execution-artifacts",
					wholeRun: { plannedExecutions: 2, usableExecutions: 0, excludedExecutions: 2, missingExecutions: 2 },
				});
				assert.equal(summary.reviewStatus, "missing");
				assert.deepEqual((summary.state as { phase: string }).phase, phase);
				assert.equal(existsSync(join(prepared.directory, "review.json")), false);
				assert.equal(existsSync(join(prepared.directory, "execution-files.json")), false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("separates absent review entries from usable execution artifacts", () => {
		const fixture = createFixture("completed", [[], []]);
		try {
			const reviewPath = join(fixture.directory, "review.json");
			writeJson(reviewPath, { cases: [{ id: "case", entries: [] }] });
			const summary = inspectRun(fixture.root, fixture.runId, false, { summary: true });
			assert.equal(summary.reviewStatus, "available");
			const cases = summary.cases as Array<{ entries: Array<{ evidenceStatus: string; reviewEntry: string }> }>;
			assert.ok(
				cases[0].entries.every((entry) => entry.evidenceStatus === "usable" && entry.reviewEntry === "missing"),
			);
			rmSync(reviewPath);
			const detail = inspectRun(fixture.root, fixture.runId, false, { caseIds: ["case"] });
			assert.equal(detail.reviewStatus, "missing");
			assert.equal(Object.hasOwn(detail, "review"), false);
			assert.deepEqual(detail.cases, summary.cases);
		} finally {
			removeFixture(fixture);
		}
	});

	it("rejects unsafe selectors and reveal in compact output", () => {
		const fixture = createFixture("completed", [[], []]);
		try {
			for (const summary of [false, true]) {
				assert.throws(
					() => inspectRun(fixture.root, fixture.runId, false, { summary, caseIds: ["case", "case"] }),
					/duplicate/,
				);
				assert.throws(
					() => inspectRun(fixture.root, fixture.runId, false, { summary, caseIds: ["unknown"] }),
					/not in this run plan/,
				);
			}
			assert.throws(() => inspectRun(fixture.root, fixture.runId, true, { summary: true }), /cannot be combined/);
		} finally {
			removeFixture(fixture);
		}
	});

	it("keeps current artifact corruption visible in compact inspection", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const manifest = readJson<{ files: string[] }>(join(fixture.directory, "execution-files.json"));
			const path = join(fixture.directory, "executions", manifest.files[0]);
			const entry = readJson<{ result: { errors: unknown } }>(path);
			entry.result.errors = { wrong: "shape" };
			writeJson(path, entry);
			const summary = inspectRun(fixture.root, fixture.runId, false, { summary: true });
			assert.match(JSON.stringify(summary), /InvalidExecutionEvidence/);
			writeFileSync(path, "{not-json");
			assert.throws(() => inspectRun(fixture.root, fixture.runId, false, { summary: true }), SyntaxError);
			writeJson(path, entry);
			for (const invalid of [null, false, "", { cases: "bad" }]) {
				writeJson(join(fixture.directory, "review.json"), invalid);
				assert.throws(() => inspectRun(fixture.root, fixture.runId, false, { summary: true }), /Review artifact/);
				assert.throws(() => inspectRun(fixture.root, fixture.runId, false, { caseIds: ["case"] }), /Review artifact/);
				assert.doesNotThrow(() => inspectRun(fixture.root, fixture.runId, false));
			}
		} finally {
			removeFixture(fixture);
		}
	});

	it("leaves artifacts and scoped adjudication unchanged after compact and selected inspection", () => {
		const fixture = createFixture("partial", [[], providerError]);
		try {
			const files = [
				"plan.json",
				"state.json",
				"review.json",
				"variant-map.json",
				"execution-files.json",
				...participants.map((participant) => `executions/${executionId(participant)}.json`),
			];
			const before = files.map((file) => readFileSync(join(fixture.directory, file), "utf8"));
			inspectRun(fixture.root, fixture.runId, false, { summary: true });
			const detail = inspectRun(fixture.root, fixture.runId, true, { caseIds: ["case"] });
			assert.deepEqual(detail.review, readJson(join(fixture.directory, "review.json")));
			assert.deepEqual(detail.variantMapping, { variantToLabel: { variant: "A" } });
			assert.deepEqual(
				files.map((file) => readFileSync(join(fixture.directory, file), "utf8")),
				before,
			);
			adjudicateRun(fixture.root, fixture.runId, "pass", "Reviewed usable evidence.", "A", "usable-executions");
			const record = readJson<AdjudicationRecord>(join(fixture.directory, "adjudication.json"));
			assert.deepEqual(record.scope, { type: "usable-executions", executionIds: [executionId(participants[0])] });
			assert.equal(
				(inspectRun(fixture.root, fixture.runId, false, { summary: true }).state as { quality: { status: string } })
					.quality.status,
				"pass",
			);
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
