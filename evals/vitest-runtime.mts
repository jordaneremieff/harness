import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import assert from "node:assert/strict";

import { createHarness as createVitestHarness, describeEval as describeVitestEval, type JsonValue } from "vitest-evals";

import { getSubjectAdapter } from "./adapters.mts";
import { verifyPlan } from "./core.mts";
import type {
	EvaluationCase,
	EvaluationPlan,
	EvaluationSuite,
	Participant,
	SubjectExecution,
	SubjectRunResult,
	SubjectVariant,
} from "./types.mts";

interface PlannedExecutionInput extends SubjectExecution {}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	chmodSync(path, 0o600);
}

function findById<T extends { id: string }>(values: T[], id: string, field: string): T {
	const value = values.find((candidate) => candidate.id === id);
	if (!value) throw new Error(`${field} ${id} is absent from the approved plan`);
	return value;
}

function executionCost(runDirectory: string): number {
	const directory = join(runDirectory, "executions");
	const manifestPath = join(runDirectory, "execution-files.json");
	if (!existsSync(directory) || !existsSync(manifestPath)) return 0;
	const manifest = readJson<{ files?: string[] }>(manifestPath);
	let total = 0;
	for (const file of manifest.files ?? []) {
		const evidence = readJson<{ result?: { usage?: { metadata?: { cost?: number } } } }>(join(directory, file));
		total += evidence.result?.usage?.metadata?.cost ?? 0;
	}
	return total;
}

function appendExecutionFile(runDirectory: string, filename: string): void {
	const path = join(runDirectory, "execution-files.json");
	const manifest = existsSync(path) ? readJson<{ files: string[] }>(path) : { files: [] };
	if (!manifest.files.includes(filename)) manifest.files.push(filename);
	manifest.files.sort();
	writeJsonAtomic(path, manifest);
}

function failedRun(error: unknown, input: PlannedExecutionInput, participant: Participant): SubjectRunResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		output: {
			value: { text: "" },
			effective: {
				requestedProvider: participant.provider,
				requestedModel: participant.model,
				requestedThinking: participant.thinking,
			},
			checks: [],
		},
		events: [
			{ type: "message", role: "user", content: `Execution ${input.executionId} failed before transcript capture.` },
		],
		usage: { provider: participant.provider, model: participant.model },
		errors: [{ type: error instanceof Error ? error.name : "Error", message }],
	};
}

function plannedExecutions(plan: EvaluationPlan, labels: Record<string, string>): PlannedExecutionInput[] {
	const executions: PlannedExecutionInput[] = [];
	for (const evaluationCase of plan.cases) {
		for (const participant of plan.participants) {
			for (let repetition = 1; repetition <= plan.invocation.repetitions; repetition += 1) {
				for (const variant of plan.variants) {
					const executionId = [
						evaluationCase.id,
						participant.provider,
						participant.model,
						participant.thinking,
						repetition,
						variant.id,
					]
						.join("--")
						.replace(/[^a-zA-Z0-9._-]/g, "_");
					executions.push({
						executionId,
						caseId: evaluationCase.id,
						variantId: variant.id,
						participantId: participant.id,
						repetition,
						blindLabel: labels[variant.id] ?? "unmapped",
					});
				}
			}
		}
	}
	return executions;
}

export function registerPlannedSuite(suite: EvaluationSuite): void {
	const planPath = process.env.HARNESS_EVAL_PLAN_PATH;
	const runDirectory = process.env.HARNESS_EVAL_RUN_DIRECTORY;
	const labelsPath = process.env.HARNESS_EVAL_LABELS_PATH;
	if (!planPath || !runDirectory || !labelsPath) return;
	const plan = readJson<EvaluationPlan>(planPath);
	const labels = readJson<{ variantToLabel: Record<string, string> }>(labelsPath).variantToLabel;
	const adapter = getSubjectAdapter(suite.subject.adapter);
	verifyPlan(suite, plan, adapter);

	const harness = createVitestHarness<PlannedExecutionInput, JsonValue>({
		name: `${suite.id}:${adapter.id}`,
		run: async ({ input, signal }) => {
			const evaluationCase = findById<EvaluationCase>(plan.cases, input.caseId, "case");
			const variant = findById<SubjectVariant>(plan.variants, input.variantId, "variant");
			const participant = findById<Participant>(plan.participants, input.participantId, "participant");
			let result: SubjectRunResult;
			try {
				const observedCost = executionCost(runDirectory);
				if (
					observedCost > plan.limits.cost.maxObserved ||
					(plan.limits.cost.maxObserved > 0 && observedCost === plan.limits.cost.maxObserved)
				) {
					const error = new Error(
						`Observed cost ${observedCost} reached the post-execution limit ${plan.limits.cost.maxObserved}; this is not a hard spend cap.`,
					);
					error.name = "BlockedError";
					throw error;
				}
				result = await adapter.run({
					suitePath: plan.suite.path,
					subjectKind: plan.subjectResolution.kind,
					subjectConfig: plan.subjectResolution.config,
					variant,
					evaluationCase,
					participant,
					limits: plan.limits,
					authority: plan.authority,
					grant: plan.invocation.grant,
					runDirectory,
					execution: input,
					signal,
				});
			} catch (error) {
				result = failedRun(error, input, participant);
			}

			const filename = `${input.executionId}.json`;
			writeJsonAtomic(join(runDirectory, "executions", filename), {
				execution: input,
				case: { id: evaluationCase.id, title: evaluationCase.title, reviewMetadata: evaluationCase.reviewMetadata },
				participant,
				result,
			});
			appendExecutionFile(runDirectory, filename);
			return {
				output: result.output as unknown as JsonValue,
				events: result.events,
				usage: result.usage,
				errors: result.errors,
				artifacts: {
					executionId: input.executionId,
					blindLabel: input.blindLabel,
					checks: result.output.checks,
				},
			};
		},
	});

	describeVitestEval(suite.title, { harness }, (it) => {
		for (const execution of plannedExecutions(plan, labels)) {
			it(`${execution.caseId} / ${execution.participantId} / repetition ${execution.repetition} / ${execution.blindLabel}`, async ({
				run,
			}) => {
				const result = await run(execution);
				assert.deepEqual(result.errors, []);
			});
		}
	});
}
