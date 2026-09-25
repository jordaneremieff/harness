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
	Participant,
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

interface PlannedEvidenceSlot {
	executionId: string;
	caseId: string;
	variantId: string;
	participant: Participant;
	repetition: number;
}

function plannedEvidenceSlots(plan: EvaluationPlan): PlannedEvidenceSlot[] {
	const slots: PlannedEvidenceSlot[] = [];
	for (const evaluationCase of plan.cases) {
		for (const participant of plan.participants) {
			for (let repetition = 1; repetition <= plan.invocation.repetitions; repetition += 1) {
				for (const variant of plan.variants) {
					slots.push({
						executionId: [
							evaluationCase.id,
							participant.provider,
							participant.model,
							participant.thinking,
							repetition,
							variant.id,
						]
							.join("--")
							.replace(/[^a-zA-Z0-9._-]/g, "_"),
						caseId: evaluationCase.id,
						variantId: variant.id,
						participant,
						repetition,
					});
				}
			}
		}
	}
	return slots;
}

function executionEvidenceById(directory: string): Map<string, StoredExecutionEvidence> {
	const evidence = listExecutionEvidence(directory) as unknown as StoredExecutionEvidence[];
	return new Map(
		evidence
			.filter((entry) => typeof entry.execution?.executionId === "string")
			.map((entry) => [entry.execution.executionId, entry] as const),
	);
}

function coverageForSlots(
	slots: PlannedEvidenceSlot[],
	evidenceById: Map<string, StoredExecutionEvidence>,
): RunCoverage {
	const usableExecutionIds: string[] = [];
	const exclusions: RunCoverage["exclusions"] = [];
	for (const { executionId } of slots) {
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
		plannedExecutions: slots.length,
		usableExecutions: usableExecutionIds.length,
		excludedExecutions: exclusions.length,
		usableExecutionIds,
		exclusions,
	};
}

export function buildRunCoverage(directory: string, plan: EvaluationPlan): RunCoverage {
	return coverageForSlots(plannedEvidenceSlots(plan), executionEvidenceById(directory));
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

interface InspectOptions {
	summary?: boolean;
	caseIds?: string[];
}

interface InspectionReview {
	cases: Array<{ id: string; entries: Array<{ executionId: string }> }>;
}

function assertInspectionReview(review: InspectionReview): void {
	if (
		!review ||
		!Array.isArray(review.cases) ||
		review.cases.some(
			(value) =>
				!value ||
				typeof value.id !== "string" ||
				!Array.isArray(value.entries) ||
				value.entries.some((entry) => !entry || typeof entry.executionId !== "string"),
		)
	) {
		throw new Error("Review artifact must contain case ids and execution entry arrays");
	}
}

function coverageCounts(coverage: RunCoverage, slots: PlannedEvidenceSlot[], missing: Set<string>) {
	const usable = new Set(coverage.usableExecutionIds);
	const usableExecutions = slots.filter((slot) => usable.has(slot.executionId)).length;
	return {
		plannedExecutions: slots.length,
		usableExecutions,
		excludedExecutions: slots.length - usableExecutions,
		missingExecutions: slots.filter((slot) => missing.has(slot.executionId)).length,
	};
}

function inspectEvidenceSlot(
	slot: PlannedEvidenceSlot,
	label: unknown,
	errorTypes: string[],
	missing: boolean,
	reviewed: boolean,
) {
	if (typeof label !== "string" || !/^(?:[A-Z]|V\d+)$/.test(label)) {
		throw new Error("Variant mapping lacks a valid display label");
	}
	const evidenceStatus = missing ? "missing" : errorTypes.length === 0 ? "usable" : "excluded";
	return {
		label,
		participant: {
			provider: slot.participant.provider,
			model: slot.participant.model,
			thinking: slot.participant.thinking,
		},
		repetition: slot.repetition,
		evidenceStatus,
		...(errorTypes.length > 0 ? { errorTypes } : {}),
		reviewEntry: reviewed ? "available" : "missing",
	};
}

function inspectEvidenceView(
	directory: string,
	state: RunState,
	review: InspectionReview | undefined,
	options: InspectOptions,
): Record<string, unknown> {
	const plan = readJson<EvaluationPlan>(join(directory, "plan.json"));
	const selected = new Set(options.caseIds ?? []);
	if (selected.size !== (options.caseIds?.length ?? 0)) throw new Error("Case selection contains a duplicate");
	for (const id of selected) {
		if (!plan.cases.some((value) => value.id === id)) throw new Error(`Case is not in this run plan: ${id}`);
	}
	if (review !== undefined) assertInspectionReview(review);
	const cases = plan.cases.filter((value) => selected.size === 0 || selected.has(value.id));
	const slots = plannedEvidenceSlots(plan);
	const evidenceById = executionEvidenceById(directory);
	const missing = new Set(slots.filter((slot) => !evidenceById.has(slot.executionId)).map((slot) => slot.executionId));
	const coverage = coverageForSlots(slots, evidenceById);
	const exclusions = new Map(coverage.exclusions.map((entry) => [entry.executionId, entry.errorTypes]));
	const mapping = readJson<{ variantToLabel: Record<string, string> }>(join(directory, "variant-map.json"));
	const caseIds = new Set(cases.map((value) => value.id));
	const inventories = cases.map((value) => {
		const caseSlots = slots.filter((slot) => slot.caseId === value.id);
		const reviewIds = new Set(
			review?.cases.find((candidate) => candidate.id === value.id)?.entries.map((entry) => entry.executionId),
		);
		return {
			id: value.id,
			title: value.title,
			coverage: coverageCounts(coverage, caseSlots, missing),
			entries: caseSlots.map((slot) =>
				inspectEvidenceSlot(
					slot,
					mapping.variantToLabel?.[slot.variantId],
					exclusions.get(slot.executionId) ?? [],
					missing.has(slot.executionId),
					reviewIds.has(slot.executionId),
				),
			),
		};
	});
	return {
		view: {
			mode: options.summary ? "summary" : "case-detail",
			scope: selected.size > 0 ? "selected-cases" : "whole-run",
			caseIds: cases.map((value) => value.id),
		},
		runId: state.runId,
		state: options.summary
			? {
					phase: state.phase,
					operational: { status: state.operational.status ?? null },
					quality: { status: state.quality.status },
				}
			: state,
		reviewStatus: review ? "available" : "missing",
		coverage: {
			source: "current-execution-artifacts",
			wholeRun: coverageCounts(coverage, slots, missing),
			...(selected.size > 0
				? {
						selectedCases: coverageCounts(
							coverage,
							slots.filter((slot) => caseIds.has(slot.caseId)),
							missing,
						),
					}
				: {}),
		},
		note: "Usable evidence has no execution errors; it is not a quality verdict. Missing executions are included in excludedExecutions.",
		cases: inventories,
		...(!options.summary && review
			? { review: { ...review, cases: review.cases.filter((value) => caseIds.has(value.id)) } }
			: {}),
	};
}

export function inspectRun(
	evidenceRoot: string,
	runId: string,
	reveal: boolean,
	options: InspectOptions = {},
): Record<string, unknown> {
	if (options.summary && reveal)
		throw new Error("--summary cannot be combined with --reveal; use full inspection to reveal variants");
	const directory = runDirectory(evidenceRoot, runId);
	const state = readJson<RunState>(join(directory, "state.json"));
	const review = existsSync(join(directory, "review.json"))
		? readJson<InspectionReview>(join(directory, "review.json"))
		: undefined;
	const view =
		options.summary || options.caseIds?.length
			? inspectEvidenceView(directory, state, review, options)
			: { state, ...(review ? { review } : {}) };
	return {
		...view,
		...(reveal ? { variantMapping: readJson(join(directory, "variant-map.json")) } : {}),
	};
}

interface StoredReview {
	cases: Array<{ entries: Array<{ executionId?: string; evidenceStatus?: string; label: string }> }>;
}

function resolveAdjudicationScope(
	state: RunState,
	verdict: Exclude<QualityStatus, "not_assessed">,
	scope: "usable-executions" | undefined,
): string[] | undefined {
	const conclusive = verdict === "pass" || verdict === "fail";
	if (state.operational.status === "partial" && conclusive) {
		if (scope !== "usable-executions") {
			throw new Error("A partial run pass or fail must be explicitly scoped to usable executions");
		}
		if (!state.coverage || state.coverage.usableExecutionIds.length === 0) {
			throw new Error("A partial run requires persisted usable execution coverage");
		}
		return [...state.coverage.usableExecutionIds];
	}
	if (state.operational.status !== "completed" && conclusive) {
		throw new Error("An operationally incomplete run permits only an inconclusive adjudication");
	}
	if (scope) throw new Error("Usable-execution scope is valid only for a partial pass or fail");
	return undefined;
}

function collectReviewLabels(review: StoredReview, coveredIds: Set<string> | undefined): Set<string> {
	const labels = new Set<string>();
	for (const evaluationCase of review.cases) {
		for (const entry of evaluationCase.entries) {
			if (coveredIds && (entry.executionId === undefined || !coveredIds.has(entry.executionId))) continue;
			labels.add(entry.label);
		}
	}
	return labels;
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
	const coveredExecutionIds = resolveAdjudicationScope(state, verdict, scope);
	if (state.quality.adjudicationFile || existsSync(join(directory, "adjudication.json"))) {
		throw new Error("This run already has an adjudication; adjudication records are immutable");
	}
	const review = readJson<StoredReview>(join(directory, "review.json"));
	const coveredIds = coveredExecutionIds ? new Set(coveredExecutionIds) : undefined;
	const labels = collectReviewLabels(review, coveredIds);
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
