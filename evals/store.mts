import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
	AdjudicationRecord,
	EvaluationPlan,
	EvaluationSuite,
	QualityStatus,
	RunCoverage,
	RunState,
} from "./types.mts";

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export function createRunId(now = new Date()): string {
	return `${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
}

export function runDirectory(evidenceRoot: string, runId: string): string {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run id: ${runId}`);
	return join(resolve(evidenceRoot), runId);
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	chmodSync(path, 0o600);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function blindVariantLabels(plan: EvaluationPlan, runId: string): Record<string, string> {
	const ordered = [...plan.variants].sort((left, right) => {
		const leftKey = createHash("sha256").update(`${runId}:${plan.digest}:${left.id}`).digest("hex");
		const rightKey = createHash("sha256").update(`${runId}:${plan.digest}:${right.id}`).digest("hex");
		return leftKey.localeCompare(rightKey);
	});
	return Object.fromEntries(
		ordered.map((variant, index) => [variant.id, index < 26 ? String.fromCharCode(65 + index) : `V${index + 1}`]),
	);
}

export function prepareRun(
	evidenceRoot: string,
	plan: EvaluationPlan,
): { runId: string; directory: string; state: RunState } {
	mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
	chmodSync(evidenceRoot, 0o700);
	const runId = createRunId();
	const directory = runDirectory(evidenceRoot, runId);
	mkdirSync(directory, { recursive: false, mode: 0o700 });
	const state: RunState = {
		schemaVersion: 1,
		runId,
		planDigest: plan.digest,
		phase: "prepared",
		operational: {},
		quality: { status: "not_assessed" },
	};
	writeJson(join(directory, "plan.json"), plan);
	writeJson(join(directory, "state.json"), state);
	writeJson(join(directory, "variant-map.json"), { variantToLabel: blindVariantLabels(plan, runId) });
	return { runId, directory, state };
}

export function listExecutionEvidence(directory: string): Array<Record<string, unknown>> {
	const manifestPath = join(directory, "execution-files.json");
	if (!existsSync(manifestPath)) return [];
	const manifest = readJson<unknown>(manifestPath);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		!Array.isArray((manifest as { files?: unknown }).files)
	) {
		throw new Error("Execution evidence manifest must contain a files array");
	}
	return (manifest as { files: unknown[] }).files.map((file) => {
		if (typeof file !== "string" || basename(file) !== file || !file.endsWith(".json")) {
			throw new Error(`Invalid execution evidence path: ${String(file)}`);
		}
		return readJson<Record<string, unknown>>(join(directory, "executions", file));
	});
}

interface StoredExecutionEvidence {
	execution: { executionId: string; caseId: string; blindLabel: string; repetition: number };
	case: { id: string; title: string; reviewMetadata?: unknown };
	participant: unknown;
	result: {
		output: { value: unknown; effective: unknown; checks: unknown };
		events: unknown;
		usage: unknown;
		errors: unknown;
	};
}

function executionErrorTypes(errors: unknown): string[] {
	if (!Array.isArray(errors)) return ["InvalidExecutionEvidence"];
	return [
		...new Set(
			errors.map((error) => {
				if (!error || typeof error !== "object" || Array.isArray(error)) return "Error";
				const type = (error as { type?: unknown }).type;
				return typeof type === "string" && type.trim() !== "" ? type : "Error";
			}),
		),
	];
}

function plannedExecutionIds(plan: EvaluationPlan): string[] {
	const executionIds: string[] = [];
	for (const evaluationCase of plan.cases) {
		for (const participant of plan.participants) {
			for (let repetition = 1; repetition <= plan.invocation.repetitions; repetition += 1) {
				for (const variant of plan.variants) {
					executionIds.push(
						[evaluationCase.id, participant.provider, participant.model, participant.thinking, repetition, variant.id]
							.join("--")
							.replace(/[^a-zA-Z0-9._-]/g, "_"),
					);
				}
			}
		}
	}
	return executionIds;
}

export function buildRunCoverage(directory: string, plan: EvaluationPlan): RunCoverage {
	const evidence = listExecutionEvidence(directory) as unknown as StoredExecutionEvidence[];
	const evidenceById = new Map(
		evidence
			.filter((entry) => typeof entry.execution?.executionId === "string")
			.map((entry) => [entry.execution.executionId, entry] as const),
	);
	const usableExecutionIds: string[] = [];
	const exclusions: RunCoverage["exclusions"] = [];
	const plannedIds = plannedExecutionIds(plan);
	for (const executionId of plannedIds) {
		const entry = evidenceById.get(executionId);
		if (!entry) {
			exclusions.push({ executionId, errorTypes: ["MissingExecutionEvidence"] });
			continue;
		}
		const errorTypes = executionErrorTypes(entry.result?.errors);
		if (errorTypes.length === 0) usableExecutionIds.push(executionId);
		else exclusions.push({ executionId, errorTypes });
	}
	return {
		plannedExecutions: plannedIds.length,
		usableExecutions: usableExecutionIds.length,
		excludedExecutions: exclusions.length,
		usableExecutionIds,
		exclusions,
	};
}

export function buildReviewArtifact(
	directory: string,
	suite: EvaluationSuite,
	state: RunState,
): Record<string, unknown> {
	const evidence = listExecutionEvidence(directory) as unknown as StoredExecutionEvidence[];
	const usableExecutionIds = state.coverage ? new Set(state.coverage.usableExecutionIds) : undefined;
	const exclusions = new Map(state.coverage?.exclusions.map((value) => [value.executionId, value]) ?? []);
	return {
		schemaVersion: 1,
		runId: state.runId,
		suite: { id: suite.id, title: suite.title },
		operational: state.operational,
		...(state.coverage ? { coverage: state.coverage } : {}),
		quality: state.quality,
		adjudication: suite.adjudication,
		note: "Deterministic checks are structural or lexical floors. A passing floor does not establish semantic quality.",
		cases: suite.cases.map((evaluationCase) => ({
			id: evaluationCase.id,
			title: evaluationCase.title,
			input: evaluationCase.input,
			reviewMetadata: evaluationCase.reviewMetadata,
			entries: evidence
				.filter((entry) => entry.execution.caseId === evaluationCase.id)
				.map((entry) => {
					const executionId = entry.execution.executionId;
					const errorTypes = executionErrorTypes(entry.result.errors);
					const usable = usableExecutionIds ? usableExecutionIds.has(executionId) : errorTypes.length === 0;
					return {
						executionId,
						evidenceStatus: usable ? "usable" : "excluded",
						label: entry.execution.blindLabel,
						repetition: entry.execution.repetition,
						participant: entry.participant,
						output: entry.result.output.value,
						effective: entry.result.output.effective,
						events: entry.result.events,
						...(usable
							? { checks: entry.result.output.checks }
							: {
									exclusion: exclusions.get(executionId) ?? { executionId, errorTypes },
								}),
						usage: entry.result.usage,
						errors: entry.result.errors,
					};
				}),
		})),
	};
}

export function inspectRun(evidenceRoot: string, runId: string, reveal: boolean): Record<string, unknown> {
	const directory = runDirectory(evidenceRoot, runId);
	const state = readJson<RunState>(join(directory, "state.json"));
	const review = existsSync(join(directory, "review.json")) ? readJson(join(directory, "review.json")) : undefined;
	return {
		state,
		...(review ? { review } : {}),
		...(reveal ? { variantMapping: readJson(join(directory, "variant-map.json")) } : {}),
	};
}

export function adjudicateRun(
	evidenceRoot: string,
	runId: string,
	verdict: Exclude<QualityStatus, "not_assessed">,
	notes: string,
	preferredLabel?: string,
	scope?: "usable-executions",
): RunState {
	if (notes.trim() === "") throw new Error("Adjudication notes are required");
	const directory = runDirectory(evidenceRoot, runId);
	const state = readJson<RunState>(join(directory, "state.json"));
	if (state.phase !== "terminal") throw new Error("Only a terminal run can be adjudicated");
	const conclusive = verdict === "pass" || verdict === "fail";
	let coveredExecutionIds: string[] | undefined;
	if (state.operational.status === "partial" && conclusive) {
		if (scope !== "usable-executions") {
			throw new Error("A partial run pass or fail must be explicitly scoped to usable executions");
		}
		if (!state.coverage || state.coverage.usableExecutionIds.length === 0) {
			throw new Error("A partial run requires persisted usable execution coverage");
		}
		coveredExecutionIds = [...state.coverage.usableExecutionIds];
	} else {
		if (state.operational.status !== "completed" && conclusive) {
			throw new Error("An operationally incomplete run permits only an inconclusive adjudication");
		}
		if (scope) throw new Error("Usable-execution scope is valid only for a partial pass or fail");
	}
	if (state.quality.adjudicationFile || existsSync(join(directory, "adjudication.json"))) {
		throw new Error("This run already has an adjudication; adjudication records are immutable");
	}
	const review = readJson<{
		cases: Array<{ entries: Array<{ executionId?: string; evidenceStatus?: string; label: string }> }>;
	}>(join(directory, "review.json"));
	const coveredIds = coveredExecutionIds ? new Set(coveredExecutionIds) : undefined;
	const labels = new Set(
		review.cases.flatMap((value) =>
			value.entries
				.filter((entry) => !coveredIds || (entry.executionId !== undefined && coveredIds.has(entry.executionId)))
				.map((entry) => entry.label),
		),
	);
	if (preferredLabel && !labels.has(preferredLabel)) throw new Error(`Unknown blinded label: ${preferredLabel}`);
	const adjudication: AdjudicationRecord = {
		adjudicatedAt: new Date().toISOString(),
		verdict,
		notes: notes.trim(),
		...(preferredLabel ? { preferredLabel } : {}),
		...(coveredExecutionIds
			? { scope: { type: "usable-executions" as const, executionIds: coveredExecutionIds } }
			: {}),
	};
	writeJson(join(directory, "adjudication.json"), adjudication);
	state.quality = { status: verdict, adjudicationFile: "adjudication.json" };
	writeJson(join(directory, "state.json"), state);
	return state;
}

export function deleteRun(evidenceRoot: string, runId: string, approval: string): void {
	if (approval !== runId) throw new Error("Delete approval must exactly match the run id");
	const directory = runDirectory(evidenceRoot, runId);
	if (!existsSync(directory)) throw new Error(`Run does not exist: ${runId}`);
	const root = existsSync(evidenceRoot) ? realpathSync(evidenceRoot) : resolve(evidenceRoot);
	if (dirname(realpathSync(directory)) !== root) throw new Error("Refusing to delete outside the evidence root");
	rmSync(directory, { recursive: true, force: false });
}
