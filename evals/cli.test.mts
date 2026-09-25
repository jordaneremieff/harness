import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSubjectAdapter } from "./adapters.mts";
import { refineOperationalStatus, runCli, runExitCode } from "./cli.mts";
import { createPlan, loadSuite, parseParticipant } from "./core.mts";
import { buildReviewArtifact, buildRunCoverage, prepareRun, writeJson } from "./store.mts";
import type { EvaluationSuite, OperationalStatus, RunState } from "./types.mts";

async function captureCli(
	args: string[],
	evidenceRoot?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: await runCli(args, evidenceRoot), stdout, stderr };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}
}

function writePiSuite(
	directory: string,
	evaluationCase: EvaluationSuite["cases"][number],
	extraCases: EvaluationSuite["cases"] = [],
): string {
	const path = join(directory, "fixture.eval.mts");
	const suite: EvaluationSuite = {
		schemaVersion: 1,
		id: "preflight-fixture",
		title: "Preflight fixture",
		subject: {
			adapter: "pi-sdk",
			kind: "adhoc",
			description: "Preflight fixture",
			config: {},
			variants: [{ id: "baseline", description: "Baseline", config: {} }],
		},
		cases: [evaluationCase, ...extraCases],
		limits: {
			wall: { runTimeoutMs: 10_000, executionTimeoutMs: 1_000 },
			execution: { maxTotal: 8, maxTurnsEach: 1, maxOutputTokensEach: 32 },
			cost: { currency: "USD", maxObserved: 0, enforcement: "observed-after-each-execution", hardCap: false },
		},
		authority: { requestedEffects: { providerNetwork: [], credentials: [], subject: [] } },
		adjudication: { policy: "deterministic-only", criteria: [] },
	};
	writeFileSync(path, `export default ${JSON.stringify(suite)};\n`);
	return path;
}

function evidenceDirectory(errors: Array<Array<{ type: string; message: string }>>): string {
	const directory = mkdtempSync(join(tmpdir(), "evals-cli-test-"));
	mkdirSync(join(directory, "executions"), { recursive: true });
	const files: string[] = [];
	for (const [index, executionErrors] of errors.entries()) {
		const file = `execution-${index}.json`;
		writeFileSync(join(directory, "executions", file), `${JSON.stringify({ result: { errors: executionErrors } })}\n`);
		files.push(file);
	}
	writeFileSync(join(directory, "execution-files.json"), `${JSON.stringify({ files })}\n`);
	return directory;
}

function classify(errors: Array<Array<{ type: string; message: string }>>): OperationalStatus | undefined {
	const directory = evidenceDirectory(errors);
	try {
		return refineOperationalStatus(directory, "failed");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("CLI argument grammar", () => {
	it("rejects retired suite and run value options", async () => {
		const suite = await captureCli(["validate", "prompts/wtf.eval.mts", "--suite", "prompts/wtf.eval.mts"]);
		assert.equal(suite.code, 1);
		assert.equal(suite.stderr, "evals: Unknown option: --suite\n");
		const run = await captureCli(["inspect", "missing", "--run", "missing"]);
		assert.equal(run.code, 1);
		assert.equal(run.stderr, "evals: Unknown option: --run\n");
	});

	it("keeps suite paths and run IDs positional", async () => {
		const suite = await captureCli(["validate", "prompts/wtf.eval.mts"]);
		assert.equal(suite.code, 0);
		assert.equal(suite.stderr, "");
		assert.equal((JSON.parse(suite.stdout) as { valid?: boolean }).valid, true);
		const run = await captureCli(["inspect", "missing"]);
		assert.equal(run.code, 1);
		assert.equal(run.stderr, "evals: Invalid run id: missing\n");
	});

	it("rejects adapter-invalid checks during validate with case and check ids", async () => {
		const directory = mkdtempSync(join(tmpdir(), "evals-cli-validation-"));
		try {
			const suitePath = writePiSuite(directory, {
				id: "bad-case",
				title: "Bad case",
				input: { seed: [], prompt: "prompt" },
				checks: [{ id: "bad-check", type: "tool-call", config: { name: "read", argumentContains: ["x"] } }],
			});
			const result = await captureCli(["validate", suitePath]);
			assert.equal(result.code, 1);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /case bad-case check bad-check\.config has unsupported field argumentContains/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("CLI evidence navigation", () => {
	it("prints compact and selected evidence through a separate CLI process without changing artifacts", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "evals-cli-inspect-"));
		try {
			const caseFor = (id: string) => ({
				id,
				title: id,
				input: { seed: [], prompt: "fixture-input-canary" },
				checks: [{ id: "check", type: "contains-exact", config: { values: ["ok"] } }],
			});
			const suitePath = writePiSuite(root, caseFor("case-a"), [caseFor("case-b"), caseFor("not-planned")]);
			const { suite } = await loadSuite(suitePath);
			const participant = parseParticipant("fixture/model:off");
			const plan = createPlan(
				suite,
				suitePath,
				[participant],
				2,
				getSubjectAdapter("pi-sdk"),
				{
					providerNetwork: "approved-effects-only",
					credentialSources: { home: false, environment: [] },
					grantedEffects: [],
				},
				{ caseIds: ["case-a", "case-b"] },
			);
			const prepared = prepareRun(root, plan);
			const files: string[] = [];
			for (const repetition of [1, 2]) {
				const executionId = `case-a--fixture--model--off--${repetition}--baseline`;
				const file = `${executionId}.json`;
				files.push(file);
				writeJson(join(prepared.directory, "executions", file), {
					execution: { executionId, caseId: "case-a", blindLabel: "A", repetition },
					case: { id: "case-a", title: "case-a" },
					participant,
					result: {
						output: {
							value: "output-canary".repeat(200),
							effective: { marker: "effective-canary" },
							checks: [{ passed: true }],
						},
						events: [{ type: "message", content: "transcript-canary".repeat(200) }],
						usage: { marker: "usage-canary" },
						errors: repetition === 1 ? [] : [{ type: "Blocked", message: "error-payload-canary" }],
					},
				});
			}
			writeJson(join(prepared.directory, "execution-files.json"), { files });
			prepared.state.phase = "terminal";
			prepared.state.operational = { status: "partial", error: "operational-error-canary" };
			prepared.state.coverage = buildRunCoverage(prepared.directory, plan);
			writeJson(join(prepared.directory, "state.json"), prepared.state);
			writeJson(
				join(prepared.directory, "review.json"),
				buildReviewArtifact(prepared.directory, suite, prepared.state),
			);
			const artifactFiles = [
				"plan.json",
				"state.json",
				"review.json",
				"variant-map.json",
				"execution-files.json",
				...files.map((file) => `executions/${file}`),
			];
			const before = artifactFiles.map((file) => readFileSync(join(prepared.directory, file), "utf8"));
			const cli = (options: string[]) =>
				spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"--eval",
						`import { runCli } from ${JSON.stringify(new URL("./cli.mts", import.meta.url).href)}; process.exitCode = await runCli(process.argv.slice(2), ${JSON.stringify(root)});`,
						"--",
						"evals-cli",
						"inspect",
						prepared.runId,
						...options,
					],
					{ encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
				);
			const full = cli([]);
			const compact = cli(["--summary"]);
			assert.ifError(full.error);
			assert.ifError(compact.error);
			assert.equal(full.status, 0, full.stderr);
			assert.equal(compact.status, 0, compact.stderr);
			const summary = JSON.parse(compact.stdout);
			assert.deepEqual(summary.view, { mode: "summary", scope: "whole-run", caseIds: ["case-a", "case-b"] });
			assert.deepEqual(summary.coverage.wholeRun, {
				plannedExecutions: 4,
				usableExecutions: 1,
				excludedExecutions: 3,
				missingExecutions: 2,
			});
			assert.equal(summary.cases[1].entries[0].evidenceStatus, "missing");
			assert.deepEqual(summary.cases[0].entries[1].errorTypes, ["Blocked"]);
			for (const omitted of [
				"baseline",
				"executionId",
				"fixture-input-canary",
				"output-canary",
				"transcript-canary",
				"effective-canary",
				"usage-canary",
				"error-payload-canary",
				"operational-error-canary",
				"checks",
				"not-planned",
			]) {
				assert.ok(!compact.stdout.includes(omitted), omitted);
			}
			assert.ok(compact.stdout.length < full.stdout.length / 3);
			t.diagnostic(
				`Synthetic CLI output bytes: full=${Buffer.byteLength(full.stdout)}, summary=${Buffer.byteLength(compact.stdout)}`,
			);
			const detail = cli(["--case", "case-a", "--reveal"]);
			assert.ifError(detail.error);
			assert.equal(detail.status, 0, detail.stderr);
			const selected = JSON.parse(detail.stdout);
			assert.deepEqual(selected.view, { mode: "case-detail", scope: "selected-cases", caseIds: ["case-a"] });
			assert.deepEqual(selected.coverage.wholeRun, summary.coverage.wholeRun);
			assert.deepEqual(selected.coverage.selectedCases, {
				plannedExecutions: 2,
				usableExecutions: 1,
				excludedExecutions: 1,
				missingExecutions: 0,
			});
			assert.deepEqual(selected.review.cases, [JSON.parse(full.stdout).review.cases[0]]);
			assert.deepEqual(selected.variantMapping, { variantToLabel: { baseline: "A" } });
			assert.match(detail.stdout, /output-canary/);
			assert.match(detail.stdout, /transcript-canary/);
			const repeated = await captureCli(
				["inspect", prepared.runId, "--summary", "--case", "case-b", "--case", "case-a"],
				root,
			);
			assert.equal(repeated.code, 0, repeated.stderr);
			assert.deepEqual(JSON.parse(repeated.stdout).view.caseIds, ["case-a", "case-b"]);
			for (const options of [
				["--case", "unknown"],
				["--case", "not-planned"],
				["--case", "case-a", "--case", "case-a"],
				["--summary", "--reveal"],
				["--case"],
			]) {
				const rejected = await captureCli(["inspect", prepared.runId, ...options], root);
				assert.equal(rejected.code, 1);
				assert.equal(rejected.stdout, "");
				assert.match(rejected.stderr, /not in this run plan|duplicate|cannot be combined|requires a value/);
			}
			const forbidden = await captureCli(["adjudicate", prepared.runId, "--summary"], root);
			assert.equal(forbidden.code, 1);
			assert.match(forbidden.stderr, /not valid for adjudicate/);
			assert.deepEqual(
				artifactFiles.map((file) => readFileSync(join(prepared.directory, file), "utf8")),
				before,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("refineOperationalStatus", () => {
	it("classifies mixed usable and errored executions as partial", () => {
		assert.equal(classify([[], [{ type: "AssistantError", message: "400 refused." }]]), "partial");
	});

	it("classifies mixed evidence after a timeout as partial", () => {
		const directory = evidenceDirectory([[], [{ type: "Timeout", message: "deadline" }]]);
		try {
			assert.equal(refineOperationalStatus(directory, "timed_out"), "partial");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("leaves a completed run completed", () => {
		const directory = evidenceDirectory([[], [{ type: "AssistantError", message: "400 refused." }]]);
		try {
			assert.equal(refineOperationalStatus(directory, "completed"), "completed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("maps a provider rejection to blocked", () => {
		const status = classify([
			[
				{ type: "AssistantError", message: "400 quota refused the request." },
				{ type: "AssistantStopReason", message: "Assistant stopped with error." },
			],
		]);
		assert.equal(status, "blocked");
	});

	it("maps an execution deadline to timed_out", () => {
		assert.equal(classify([[{ type: "Timeout", message: "deadline" }]]), "timed_out");
	});

	it("maps caller cancellation to cancelled", () => {
		assert.equal(classify([[{ type: "CancellationError", message: "cancelled" }]]), "cancelled");
	});

	it("maps a declared blocked error to blocked", () => {
		assert.equal(classify([[{ type: "BlockedError", message: "cost limit" }]]), "blocked");
	});

	it("keeps a harness failure failed", () => {
		assert.equal(classify([[{ type: "TypeError", message: "bad argument" }]]), "failed");
	});

	it("keeps mixed harness and provider failures failed", () => {
		const status = classify([
			[
				{ type: "AssistantError", message: "400 refused." },
				{ type: "TypeError", message: "bad argument" },
			],
		]);
		assert.equal(status, "failed");
	});

	it("keeps failed when no execution evidence exists", () => {
		const directory = mkdtempSync(join(tmpdir(), "evals-cli-empty-"));
		try {
			assert.equal(refineOperationalStatus(directory, "failed"), "failed");
			assert.equal(refineOperationalStatus(directory, "completed"), "completed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("runExitCode", () => {
	const state = (status: OperationalStatus): RunState => ({
		schemaVersion: 1,
		runId: "20260101T000000Z-00000000",
		planDigest: `sha256:${"0".repeat(64)}`,
		phase: "terminal",
		operational: { status },
		quality: { status: "pass" },
	});

	it("returns nonzero for a partial run", () => {
		assert.equal(runExitCode(state("partial")), 1);
	});

	it("keeps a completed passing run successful", () => {
		assert.equal(runExitCode(state("completed")), 0);
	});
});
