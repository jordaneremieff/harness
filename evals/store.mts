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
import { basename, join, resolve } from "node:path";

import type { EvaluationPlan, EvaluationSuite, QualityStatus, RunState } from "./types.mts";

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
	const manifest = readJson<{ files: string[] }>(manifestPath);
	return manifest.files.map((file) => {
		if (basename(file) !== file || !file.endsWith(".json")) throw new Error(`Invalid execution evidence path: ${file}`);
		return readJson<Record<string, unknown>>(join(directory, "executions", file));
	});
}

export function buildReviewArtifact(
	directory: string,
	suite: EvaluationSuite,
	state: RunState,
): Record<string, unknown> {
	const evidence = listExecutionEvidence(directory) as Array<{
		execution: { caseId: string; blindLabel: string; repetition: number };
		case: { id: string; title: string; reviewMetadata?: unknown };
		participant: unknown;
		result: {
			output: { value: unknown; effective: unknown; checks: unknown };
			usage: unknown;
			errors: unknown;
		};
	}>;
	return {
		schemaVersion: 1,
		runId: state.runId,
		suite: { id: suite.id, title: suite.title },
		operational: state.operational,
		quality: state.quality,
		adjudication: suite.adjudication,
		note: "Deterministic checks are lexical floors. A passing floor does not establish semantic quality.",
		cases: suite.cases.map((evaluationCase) => ({
			id: evaluationCase.id,
			title: evaluationCase.title,
			input: evaluationCase.input,
			reviewMetadata: evaluationCase.reviewMetadata,
			entries: evidence
				.filter((entry) => entry.execution.caseId === evaluationCase.id)
				.map((entry) => ({
					label: entry.execution.blindLabel,
					repetition: entry.execution.repetition,
					participant: entry.participant,
					output: entry.result.output.value,
					effective: entry.result.output.effective,
					checks: entry.result.output.checks,
					usage: entry.result.usage,
					errors: entry.result.errors,
				})),
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
): RunState {
	if (notes.trim() === "") throw new Error("Adjudication notes are required");
	const directory = runDirectory(evidenceRoot, runId);
	const state = readJson<RunState>(join(directory, "state.json"));
	if (state.phase !== "terminal") throw new Error("Only a terminal run can be adjudicated");
	if (state.operational.status !== "completed" && verdict !== "inconclusive") {
		throw new Error("An operationally incomplete run permits only an inconclusive adjudication");
	}
	if (state.quality.adjudicationFile || existsSync(join(directory, "adjudication.json"))) {
		throw new Error("This run already has an adjudication; adjudication records are immutable");
	}
	const review = readJson<{ cases: Array<{ entries: Array<{ label: string }> }> }>(join(directory, "review.json"));
	const labels = new Set(review.cases.flatMap((value) => value.entries.map((entry) => entry.label)));
	if (preferredLabel && !labels.has(preferredLabel)) throw new Error(`Unknown blinded label: ${preferredLabel}`);
	const adjudication = {
		adjudicatedAt: new Date().toISOString(),
		verdict,
		notes: notes.trim(),
		...(preferredLabel ? { preferredLabel } : {}),
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
	if (resolve(directory, "..") !== root) throw new Error("Refusing to delete outside the evidence root");
	rmSync(directory, { recursive: true, force: false });
}
